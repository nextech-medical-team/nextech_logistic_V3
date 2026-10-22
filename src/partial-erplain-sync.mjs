import {hasPartialCreatedBl} from './created-bl-label.mjs';
import {isDeepStrictEqual} from 'node:util';
import {reconcilePartialStock} from './partial-stock-reconciliation.mjs';
import {ownsPartialPreparation} from './partial-erplain-retry.mjs';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
export const syncedBlFields='id label status update_stock line_items{id parent_id quantity price variant{id sku} location{id}}';

export function syncedSelection(bc,bl){

 if(!Array.isArray(bl.line_items))throw Error('Erplain · Lignes du BL non reçues');

 return bl.line_items.filter(item=>item.variant).map(item=>{const matches=bc.line_items.filter(l=>String(l.id)===String(item.parent_id));if(matches.length!==1||String(matches[0].variant?.id)!==String(item.variant?.id))throw Error('Erplain · Ligne BL non rattachée au BC');const l=matches[0],q=Number(item.quantity);if(!Number.isFinite(q)||q<0)throw Error('Erplain · Quantité BL invalide');return {lineId:String(l.id),variantId:String(item.variant.id),locationId:String(item.location?.id||l.location?.id||''),sku:item.variant.sku||l.variant.sku,quantity:q,price:Number(item.price??l.price),ordered:Number(l.quantity),tracked:l.variant.track_inventory!==false};});

}

export function stockMismatch(delivery,stock){

 if(!delivery.stock_document?.id)return delivery.stock_document?.notRequired||!delivery.bl?.id?null:'Sortie de stock de ce BL non identifiée : rapprochement requis';

 if(!stock||String(stock.id)!==String(delivery.stock_document.id))return 'Sortie de stock Erplain introuvable';

 if(delivery.status==='cancelled')return stock.status==='cancelled'?null:'BL annulé : annuler également sa sortie de stock dans Erplain, puis actualiser';

 if(stock.status!=='completed'||stock.update_stock!==true)return 'Sortie de stock du BL non confirmée';

 const totals=items=>{if(!Array.isArray(items)||!items.length)return null;const m=new Map();for(const l of items){const variant=l?.variantId||l?.variant?.id,location=l?.locationId||l?.location?.id,q=l?.quantity;if(!variant||!location||!['number','string'].includes(typeof q)||String(q).trim()===''||!Number.isFinite(Number(q))||Number(q)<0)return null;const k=String(variant)+':'+String(location);m.set(k,(m.get(k)||0)+Number(q))}return JSON.stringify([...m].sort())};

 const expected=totals(delivery.selection),actual=totals(stock.line_items);if(expected===null||actual===null)return 'Lignes BL ou sortie de stock incomplètes : rapprochement requis';
 return expected===actual?null:'Quantités BL et sortie de stock différentes : régulariser la sortie dans Erplain, puis actualiser';

}

export async function refreshPartialFromErplain(db,api,id,{document=null,identityVerified=false}={}){

 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o?.partial_mode||!o.erp_live?.bc?.id)throw Error('Commande avec livraisons partielles requise');

 const busy=(await db.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND (status IN ('creating_bl','selecting_lines','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf') OR to_jsonb(partial_deliveries)->'temu_label'->>'state'='purchasing') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[id])).rows;if(busy.length)throw Error('Traitement en cours : attendre sa fin avant actualisation Erplain');

 if(!identityVerified)await api.verify();const bc=document||await readErplainDocuments(api,o.erp_live.bc.id);

 if(String(bc?.id)!==String(o.erp_live.bc.id)||!Array.isArray(bc.line_items)||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Erplain · Lecture BC/BL incomplète, aucune allocation modifiée');

 if(bc.line_items.filter(l=>l.variant).some(l=>!l.id||!l.variant?.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<0))throw Error('Erplain · Quantités du BC invalides');

 if(bc.shipping_orders.data.some(b=>!['cancelled','unpublished','pending','make_the_shipment','in_preparation','ready_to_ship','delivered','completed','shipped'].includes(b.status)))throw Error('Erplain · Statut BL inconnu, rapprochement requis');

 const deliveries=(await db.query('SELECT * FROM partial_deliveries WHERE order_id=$1 ORDER BY created_at',[id])).rows,updates=[],holds=[];

 if(o.erp_live.bl?.id&&o.erp_live.stockDocument?.id&&!deliveries.some(d=>String(d.stock_document?.id)===String(o.erp_live.stockDocument.id))){
  const bl=bc.shipping_orders.data.find(b=>String(b.id)===String(o.erp_live.bl.id));if(!bl)throw Error('Ancien BL global absent du BC Erplain : rapprochement requis');
  const stock=(await api.request('query V3RefreshLegacyFullStock($id:ID!){StockRemoval(id:$id){id label status update_stock line_items{quantity variant{id} location{id}}}}',{id:String(o.erp_live.stockDocument.id)})).StockRemoval;
  if(!stock||stock.label!==o.erp_live.stockDocument.label)throw Error('Sortie de stock de l’ancien BL non identifiée');
  const issue=stockMismatch({status:bl.status==='cancelled'?'cancelled':'active',stock_document:o.erp_live.stockDocument,bl,selection:bl.status==='cancelled'?[]:syncedSelection(bc,bl)},stock);if(issue)holds.push({bl:bl.label,stockId:stock.id,stockLabel:stock.label,message:issue});
 }

 for(const d of deliveries){if(!d.bl?.id||(o.channel!=='tender'&&ownsPartialPreparation(d)))continue;const bl=bc.shipping_orders.data.find(b=>String(b.id)===String(d.bl.id));if(!bl)throw Error('Erplain · BL '+d.bl.label+' absent : vérifier avant nouvelle allocation');

  const cancelled=bl.status==='cancelled',selection=cancelled?d.selection:syncedSelection(bc,bl);let stock=null;

  if(d.stock_document?.id)stock=(await api.request('query V3RefreshPartialStock($id:ID!){StockRemoval(id:$id){id label status update_stock line_items{quantity variant{id} location{id}}}}',{id:String(d.stock_document.id)})).StockRemoval;

  const update={...d,bl:{...bl,...(d.bl.labelRequest?{labelRequest:d.bl.labelRequest}:{})},status:cancelled?'cancelled':d.status==='cancelled'?'review':d.status,selection,stock_document:stock?{...d.stock_document,id:stock.id,label:stock.label,status:stock.status,update_stock:stock.update_stock}:d.stock_document};

  let reconciliationError=null;
  if(!cancelled&&!d.stock_document&&d.label_choice!=='existing_bl'){
   try{
    const recovered=await reconcilePartialStock(api,bc,update,{hasSeparateStock:!!(o.erp_live.stockDocument||o.erp_live.stockCreationAttemptedAt||deliveries.some(x=>x.stock_document?.id))});
    if(recovered){
     const problem=stockMismatch({...update,stock_document:recovered.document},recovered.stock);
     if(problem)throw Error(problem);
     update.stock_document=recovered.document;stock=recovered.stock;
    }
   }catch(error){reconciliationError=error.message;}
  }
  // Stock discrepancies remain allocation diagnostics; they cannot veto labels.
  if(hasPartialCreatedBl(update)&&update.status==='review'&&['finalizing_bl','bl_ready'].includes(d.stage)&&!d.carrier_result&&!d.tracking?.length){update.status='bl_ready';update.error=null;}
  const issue=d.label_choice==='existing_bl'?null:reconciliationError||stockMismatch(update,stock);if(issue)holds.push({deliveryId:d.id,bl:bl.label,stockId:d.stock_document?.id,stockLabel:d.stock_document?.label,message:issue});updates.push(update);

 }

 // External BL quantities still count through the complete Erplain history; no new label or stock is created by a refresh.

 const allocations=bc.shipping_orders.data.filter(b=>!['cancelled','unpublished'].includes(b.status)).flatMap(b=>syncedSelection(bc,b)).map(l=>({sku:l.sku,quantity:l.quantity}));

 const allocatedBlIds=bc.shipping_orders.data.filter(b=>!['cancelled','unpublished'].includes(b.status)).map(b=>String(b.id));
 const source={allocatedBlIds,allocations,checkedAt:new Date().toISOString(),lines:bc.line_items.filter(l=>l.variant).map(l=>({lineId:String(l.id),sku:l.variant?.sku,quantity:Number(l.quantity)})),pricing:{total:Number(bc.total),tax:bc.line_items.reduce((n,l)=>n+Number(l.tax_amount||0),0),currency:bc.currency?.label},stockHolds:holds};

 await db.transaction(async tx=>{
  const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const current=(await tx.query('SELECT * FROM partial_deliveries WHERE order_id=$1 ORDER BY created_at FOR UPDATE',[id])).rows;
  if(!fresh||!isDeepStrictEqual(fresh.erp_live,o.erp_live)||!isDeepStrictEqual(current,deliveries))throw Error('Commande ou livraison modifiée pendant la lecture : actualiser à nouveau');
  await assertDocumentIdle(tx,id);const changed=(await tx.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND (status IN ('creating_bl','selecting_lines','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf') OR to_jsonb(partial_deliveries)->'temu_label'->>'state'='purchasing')",[id])).rows;if(changed.length)throw Error('Traitement démarré pendant la lecture : actualisation différée');for(const d of updates)await tx.query('UPDATE partial_deliveries SET status=$2,selection=$3,bl=$4,stock_document=$5,error=$6,updated_at=now() WHERE id=$1',[d.id,d.status,JSON.stringify(d.selection),JSON.stringify(d.bl),JSON.stringify(d.stock_document),d.status==='review'?d.error:null]);

  await tx.query("UPDATE orders SET erp_live=jsonb_set(jsonb_set(jsonb_set(erp_live,'{bc}',$2::jsonb),'{partialSource}',$3::jsonb),'{documentSource}',$4::jsonb) WHERE id=$1",[id,JSON.stringify({...o.erp_live.bc,...bc}),JSON.stringify(source),JSON.stringify({...source,shippingOrders:bc.shipping_orders.data})]);

 });

 return {message:'BC et BL actualisés depuis Erplain. Anciennes étiquettes conservées dans l’historique.',stockHolds:holds,bc,deliveries:updates};

}
