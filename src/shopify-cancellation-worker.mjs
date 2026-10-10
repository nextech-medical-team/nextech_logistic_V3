import {shopifyObservationApi} from './shopify-observation-api.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {erplainLifecycleGateway} from './erplain-lifecycle-gateway.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';
import {restoreCancelledDeliveryStock} from './cancelled-delivery-stock.mjs';
import {proveShopifyCancellation,assertCancellationBC,assertCancellationBL} from './shopify-cancellation-policy.mjs';
const confirmedZero=value=>((typeof value==='number'&&Number.isFinite(value))||(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)))&&Number(value)===0;

export const shopifyCancellationCandidateSql=`SELECT * FROM orders WHERE channel='shopify' AND archived=false
 AND coalesce(source_payload->'shopifyCancellationSync'->>'status','') NOT IN ('complete','manual_review')
 AND (source_payload->'shopifyCancellationSync'->>'checkedAt' IS NULL OR (source_payload->'shopifyCancellationSync'->>'checkedAt')::timestamptz<now()-interval '5 minutes')
 ORDER BY (source_payload->>'cancelled'='true' OR lower(source_payload->>'financial_status')='refunded') DESC NULLS LAST,(source_payload->'shopifyCancellationSync'->>'checkedAt')::timestamptz NULLS FIRST,received_at LIMIT 1`;

export function shopifyCancellationWorker(db,directory,{reader=shopifyObservationApi(directory),api=erplainAccount(directory,'live'),lock=withShipmentLock,idle=assertDocumentIdle,restore=restoreCancelledDeliveryStock}={}){
 let running=false;
 const gateway=erplainLifecycleGateway(api);
 async function source(order){
  const known=order.source_payload?.id;
  let query,variables;
  if(known){if(!/^\d+$/.test(String(known)))throw Error('Shopify · Identifiant source invalide');query='query V3CancellationOrder($id:ID!){order(id:$id){id name updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus}}';variables={id:'gid://shopify/Order/'+known};}
  else{query='query V3CancellationReference($search:String!){orders(first:10,query:$search){nodes{id name updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus} pageInfo{hasNextPage}}}';variables={search:'name:'+order.reference};}
  const response=await reader.read(query,variables);
  if(order.source_payload?.sourceShop&&order.source_payload.sourceShop!==response.shop)throw Error('Shopify · Boutique différente');
  const nodes=known?[response.data.order]:response.data.orders?.nodes?.filter(n=>n.name===order.reference);
  if(!nodes||nodes.length!==1||!nodes[0]||!known&&response.data.orders?.pageInfo?.hasNextPage!==false)throw Error('Shopify · Commande absente ou ambiguë');
  return {...proveShopifyCancellation(order,nodes[0]),shop:response.shop};
 }
 async function save(id,state,patch={}){await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[id,JSON.stringify({...patch,shopifyCancellationSync:state})]);}
 async function cancel(order){
  let state={...(order.source_payload?.shopifyCancellationSync||{}),checkedAt:new Date().toISOString()};
  try{
   const proof=await source(order);state={...state,proof,status:proof.reason?'pending':'observed',error:null};
   if(!proof.reason){await save(order.id,state,{financial_status:proof.financial_status});return {cancelled:false,proof};}
   // Suspend preparation first; source cancellation is not carrier cancellation.
   await db.query("UPDATE orders SET resolution_pending_resume=true,label_status='cancelled',tracking_status=CASE WHEN tracking_status IN ('shipped','delivered','in_transit','delivered_simulated') THEN tracking_status ELSE 'cancelled' END,source_payload=source_payload||$2::jsonb,issue=$3 WHERE id=$1",[order.id,JSON.stringify({cancelled:true,cancelled_at:proof.cancelled_at,financial_status:proof.financial_status,shopifyCancellationSync:state}),proof.reason+' · Annulation Erplain en attente']);
   return await lock(async()=>{
    await idle(db,order.id);
    order=(await db.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0];
    if(!order||order.archived)throw Error('Commande indisponible');
    const fresh=await source(order);if(!fresh.reason)throw Error('Shopify · Annulation ou remboursement intégral non confirmé à la relecture');state.proof=fresh;
    await gateway.verifyLive();
    const readBC=async()=>{const r=await api.request('query V3CancellationBC($id:ID!){Order(id:$id){id label status external_reference invoices_count paid_amount shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{id:String(order.erp_live.bc.id)});assertCancellationBC(order,r.Order);if(!confirmedZero(r.Order.invoices_count)||!confirmedZero(r.Order.paid_amount))throw Error('BC facturé, payé ou facturation non vérifiable : rapprochement requis');return r.Order;};
    let bc=null;
    if(!order.erp_live?.bc?.id){
     if(order.erp_live?.bl?.id||order.erp_live?.stockDocument?.id||order.erp_live?.stockCreationAttemptedAt||order.erp_live?.phase==='creating_bc')throw Error('Erplain · Documents ou création incertaine à rapprocher');
     const found=(await api.request('query V3CancellationFindBC($where:QueryOrdersWhereWhereConditions!){Orders(first:100,where:$where){data{id label status external_reference} paginatorInfo{hasMorePages}}}',{where:{OR:[{column:'EXTERNAL_REFERENCE',operator:'EQ',value:order.reference},{column:'EXTERNAL_REFERENCE',operator:'EQ',value:'V3:'+order.id}]}})).Orders;
     if(!Array.isArray(found?.data)||found.paginatorInfo?.hasMorePages!==false||found.data.length>1)throw Error('Erplain · BC absents du cache : recherche incomplète ou ambiguë');
     if(found.data.length){const hit=found.data[0];if(![order.reference,'V3:'+order.id].includes(hit.external_reference)||!/^\d+$/.test(String(hit.id)))throw Error('Erplain · BC retrouvé non confirmé');order.erp_live={...(order.erp_live||{}),bc:{id:hit.id,label:hit.label,status:hit.status}};await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc}',$2::jsonb) WHERE id=$1",[order.id,JSON.stringify(order.erp_live.bc)]);}
    }
    if(order.erp_live?.bc?.id){
     bc=await readBC();state.bcId=String(bc.id);
     const deliveries=(await db.query('SELECT id,bl,stock_document FROM partial_deliveries WHERE order_id=$1',[order.id])).rows;
     const pending=[];
     for(const entry of bc.shipping_orders.data){
      const readBL=async()=>{const r=await api.request('query V3CancellationBL($id:ID!){ShippingOrder(id:$id){id label status invoices_count orders(first:100){data{id} paginatorInfo{hasMorePages}} invoices(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(entry.id)});if(String(r.ShippingOrder?.id)!==String(entry.id))throw Error('Erplain · Identité du BL non confirmée');assertCancellationBL(bc,r.ShippingOrder);const count=r.ShippingOrder.invoices_count;if(!((typeof count==='number'&&Number.isInteger(count))||(typeof count==='string'&&/^\d+$/.test(count)))||Number(count)!==0||r.ShippingOrder.invoices.data.length)throw Error('BL facturé ou facturation non vérifiable : rapprochement requis');return r.ShippingOrder;};
      let bl=await readBL();
      const full=String(order.erp_live.bl?.id)===String(bl.id),partial=deliveries.find(d=>String(d.bl?.id)===String(bl.id));
      if(!full&&!partial)throw Error('BL non enregistré dans V3 : stock associé à rapprocher');
      if(bl.status!=='cancelled'&&(fresh.fulfillment_status!=='unfulfilled'||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status)))throw Error('Expédition physique ou statut source inconnu : BL et stock conservés');
      const stock=full?order.erp_live.stockDocument:partial?.stock_document;
      if(stock?.id&&(fresh.fulfillment_status!=='unfulfilled'||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status)))throw Error('Stock d’une expédition physique ou inconnue : retour à rapprocher, aucune restitution automatique');
      pending.push({bl,readBL,full,partial,stock});
     }
     if(order.erp_live?.stockDocument?.id&&!bc.shipping_orders.data.some(b=>String(b.id)===String(order.erp_live.bl?.id)))throw Error('Sortie de stock sans BL identifié : rapprochement requis');
     // Validate every linked BL before any mutation. Reconcile cancelled BLs
     // before cancelling their parent; never infer success from a lost response.
     for(const item of pending){
      let {bl}=item;const {readBL}=item;
      if(bl.status!=='cancelled'){state.intent={kind:'bl',id:String(bl.id),at:new Date().toISOString()};await save(order.id,state);await gateway.setBLStatus(bl.id,'cancelled');bl=await readBL();if(bl.status!=='cancelled')throw Error('Erplain · Annulation BL non confirmée');}
      item.bl=bl;delete state.intent;await save(order.id,state);
     }
     const current=await readBC();
     if(JSON.stringify(current.shipping_orders.data.map(b=>String(b.id)).sort())!==JSON.stringify(bc.shipping_orders.data.map(b=>String(b.id)).sort()))throw Error('Erplain · Liste des BL modifiée avant annulation BC : rapprochement requis');
     bc=current;
     for(const item of pending){item.bl=await item.readBL();if(item.bl.status!=='cancelled')throw Error('Erplain · Annulation BL non confirmée avant BC');}
     if(bc.status!=='cancelled'){state.intent={kind:'bc',id:String(bc.id),at:new Date().toISOString()};await save(order.id,state);await gateway.cancelOrder(bc.id);bc=await readBC();if(bc.status!=='cancelled')throw Error('Erplain · Annulation BC non confirmée');}
     state.bcConfirmedAt=new Date().toISOString();delete state.intent;await save(order.id,state);
     await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc,status}','\"cancelled\"'::jsonb) WHERE id=$1",[order.id]);
     for(const {bl,full,partial,stock} of pending){
      if(full)await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}','\"cancelled\"'::jsonb) WHERE id=$1",[order.id]);
      if(partial)await db.query("UPDATE partial_deliveries SET bl=bl||'{\"status\":\"cancelled\"}'::jsonb WHERE id=$1",[partial.id]);
      if(stock?.id){if(['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))throw Error('Stock d’une expédition physique : retour à rapprocher, aucune restitution automatique');await restore(db,api,order.id,stock.id,{requireCancelledBC:true});}
      state.confirmedBLs=[...new Set([...(state.confirmedBLs||[]),String(bl.id)])];delete state.intent;await save(order.id,state);
     }
    }else if(order.erp_live?.bl?.id||order.erp_live?.stockDocument?.id||order.erp_live?.stockCreationAttemptedAt||order.erp_live?.phase==='creating_bc'){throw Error('Erplain · Documents ou création incertaine à rapprocher');}
    if(order.erp_live?.stockDocument?.id&&!bc?.shipping_orders.data.some(b=>String(b.id)===String(order.erp_live.bl?.id)))throw Error('Sortie de stock sans BL identifié : rapprochement requis');
    state.status='complete';state.completedAt=new Date().toISOString();state.error=null;delete state.intent;
    await save(order.id,state);
    await db.query("UPDATE orders SET resolution_pending_resume=true,label_status='cancelled',issue=$2 WHERE id=$1",[order.id,fresh.reason+' · '+(bc?'BC et BL Erplain annulés':'Aucun BC Erplain créé')]);
    await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system','shopify.cancellation_completed',$1)",[JSON.stringify({orderId:order.id,reason:fresh.reason,bcId:state.bcId||null,blIds:state.confirmedBLs||[],labelsPreserved:true})]);
    return {cancelled:true,state};
   });
  }catch(e){state.error=String(e.message).slice(0,600);state.status=state.bcConfirmedAt&&/BL expédié|BL partagé|BL non enregistré|Expédition physique|Stock d’une expédition|Sortie de stock sans BL/.test(state.error)?'manual_review':'review';await save(order.id,state);if(state.proof?.reason)await db.query('UPDATE orders SET issue=$2 WHERE id=$1',[order.id,state.proof.reason+' · '+state.error]);return {cancelled:false,error:state.error,state};}
 }
 return {get running(){return running;},cancel,async run(){if(running)return;running=true;try{const order=(await db.query(shopifyCancellationCandidateSql)).rows[0];if(order)return await cancel(order);}finally{running=false;}}};
}
