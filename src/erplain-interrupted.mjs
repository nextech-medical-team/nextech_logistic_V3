import {usesRecordedBc,recordedBcItems,recordedBcPricing,recordedBcFingerprint} from './existing-bc-execution.mjs';
import {temuSellerTotals} from './temu-commercial-source.mjs';
import {createHash} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {bcAllowedSql} from './bc-authorization.mjs';
import {buildBcPricing,verifySourceCommercialTotals} from './bc-pricing.mjs';
import {reconcileFullStock} from './stock-cycle.mjs';
import {assertHistoricalBlNumber} from './bl-numbering.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {convertedQuantity} from './domain.mjs';

// Only finish an interrupted, fully persisted cycle. Never enqueue an uncertain
// creation, publish a document, or repeat a stock movement from this reader.
const eligible=`j.status='review' AND (${bcAllowedSql})
 AND NOT o.partial_mode AND NOT o.resolution_pending_resume
 AND o.erp_live->>'phase'='bl_created'
 AND o.erp_live->'bc'->>'id' IS NOT NULL AND o.erp_live->'bl'->>'id' IS NOT NULL
 AND o.erp_live->'stockDocument'->>'id' IS NOT NULL
 AND (j.error LIKE 'Traitement interrompu%' OR o.erp_live->'interruptedReconciliation'->>'status'='retry')
 AND coalesce((o.erp_live->'interruptedReconciliation'->>'nextAttemptAt')::timestamptz,'epoch')<=now()
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))`;
const lineSql=`SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty,b.live_variant_id
 FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku
 LEFT JOIN erplain_product_bindings b ON b.sku=coalesce(l.target_sku,m.target_sku,l.source_sku)
 WHERE l.order_id=$1 ORDER BY l.source_line,l.id`;
const signature=(o,lines)=>createHash('sha256').update(JSON.stringify({
 erp:o.erp_live,source:o.source_payload,address:o.address,weight:o.weight_kg,
 archived:o.archived,partial:o.partial_mode,hold:o.resolution_pending_resume,issue:o.issue,lines
})).digest('hex');

export function recoveryItems(o,lines,bc){
 const products=shippingProductLines(bc.line_items||[]);
 if(!lines.length||!products.length)throw Error('BC/BL · Lignes absentes lors du rapprochement');
 return lines.map(l=>{
  const sku=l.target_sku||l.mapped_sku||(['tender','samples'].includes(o.channel)?l.source_sku:null);
  if(!sku)throw Error('BC · Mapping manquant : '+l.source_sku);
  const hits=products.filter(p=>p.variant?.sku===sku&&(!l.live_variant_id||String(p.variant.id)===String(l.live_variant_id)));
  const identities=new Set(hits.map(p=>String(p.variant.id)+':'+String(p.location?.id)));
  if(!hits.length||identities.size!==1||!hits[0].location?.id)throw Error('BC · Produit ou emplacement différent : '+sku);
  const quantity=Number(l.target_quantity??(l.source_qty?convertedQuantity(l.quantity,l.source_qty,l.target_qty):l.quantity));
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('BC · Quantité invalide : '+sku);
  return {variant:{id:String(hits[0].variant.id)},location:{id:String(hits[0].location.id)},quantity,price:0,description:sku};
 });
}

export async function verifyInterruptedDocuments(api,o,lines){
 // Enforce read-only at the API boundary, including helpers called below.
 const reader={request:async(q,v)=>{
  if(!/^query\s/.test(q)||/\bmutation\b/i.test(q))throw Error('Reprise Erplain : lecture seule obligatoire');
  const result=await api.request(q,v,4);
  if(q.includes('CheckCycleStock')){
   const bc=result.Order,bl=result.ShippingOrder;
   if(String(bc?.id)!==String(o.erp_live.bc.id)||String(bl?.id)!==String(o.erp_live.bl.id)
    ||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||bc.shipping_orders?.data?.length!==1
    ||bl.label!==o.erp_live.bl.label)throw Error('BC/BL · Identité, numéro ou liste des livraisons non confirmés');
  }
  return result;
 }};
 await api.verify();
 const state=o.erp_live;
 const r=await reader.request('query V3InterruptedDocuments($id:ID!){Order(id:$id){id status total currency{label} line_items{type quantity tax_amount variant{id sku} location{id}}} TaxCodes(first:200){data{id active tax_rates{rate}} paginatorInfo{hasMorePages}}}',{id:String(state.bc.id)});
 if(String(r.Order?.id)!==String(state.bc.id)||r.Order.status!=='active')throw Error('BC · Document absent ou statut modifié');
 o.items=usesRecordedBc(o)?recordedBcItems(r.Order):recoveryItems(o,lines,r.Order);
 let pricing;
 if(usesRecordedBc(o))pricing=recordedBcPricing(o,r.Order);
 else if(o.channel==='temu')pricing=temuSellerTotals(o);
 else if(o.source_payload?.erplainImported)pricing=state.importedCommercialSource;
 else if(state.equivalentItems)pricing=state.pricing;
 else{
  if(!Array.isArray(r.TaxCodes?.data)||r.TaxCodes.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Catalogue TVA incomplet');
  pricing=buildBcPricing(o,lines,o.items,r.TaxCodes.data,{eurExchangeRate:state.pricing?.eurExchangeRate});
 }
 if(!usesRecordedBc(o))verifySourceCommercialTotals(r.Order,pricing);
 const stock=await reconcileFullStock(reader,o,{allowCreate:false});
 if(!stock||String(stock.id)!==String(state.stockDocument.id))throw Error('Stock Erplain · Mouvement existant non confirmé : contrôle nécessaire');
 assertHistoricalBlNumber(state.bl);
 return {stock,pricing,...(usesRecordedBc(o)?{executionFingerprint:recordedBcFingerprint(r.Order)}:{})};
}

export function interruptedErplainRecovery(db,directory,{api=erplainAccount(directory,'live'),shouldStop=()=>false}={}){
 let running=false;
 async function run(){
  if(running||shouldStop())return;running=true;
  try{return await withShipmentLock(async()=>{
   if(shouldStop())return;
   const o=(await db.query(`SELECT o.*,j.error recovery_error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id WHERE ${eligible} ORDER BY j.updated_at,o.id LIMIT 1`)).rows[0];
   if(!o)return;
   const lines=(await db.query(lineSql,[o.id,o.channel])).rows,before=signature(o,lines);
   let result,error;
   try{result=await verifyInterruptedDocuments(api,o,lines);}catch(e){error=e;}
   return await db.transaction(async tx=>{
    // A correction/import may have changed this order while the API was read.
    const current=(await tx.query(`SELECT o.* FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id WHERE o.id=$1 AND ${eligible} FOR UPDATE OF o,j`,[o.id])).rows[0];
    if(!current||signature(current,(await tx.query(lineSql,[o.id,o.channel])).rows)!==before)return {status:'changed'};
    const at=new Date().toISOString();
    if(error){
     const retry=/HTTP (429|5\d\d)|timeout|timed out|fetch failed|ECONN|AbortError|TimeoutError/i.test(error.name+' '+error.message);
     const detail=String(error.message).slice(0,600);
     const reconciliation={status:retry?'retry':'review',checkedAt:at,error:detail,...(retry?{nextAttemptAt:new Date(Date.now()+300000).toISOString()}:{})};
     await tx.query('UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({interruptedReconciliation:reconciliation})]);
     await tx.query("UPDATE erp_live_jobs SET error=$2,updated_at=now() WHERE order_id=$1",[o.id,'Reprise Erplain · '+detail]);
     return {status:reconciliation.status,error:detail};
    }
    const erp={...current.erp_live,stockDocument:result.stock,pricing:result.pricing,stockCheckedAt:at,verifiedAt:at,
     ...(result.executionFingerprint?{mappingPreparationFingerprint:result.executionFingerprint,preparationAuthority:{kind:'recorded_bc',bcId:String(current.erp_live.bc.id),fingerprint:result.executionFingerprint}}:{}),
     labelPreparationFingerprint:await shipmentFingerprint(tx,current),
     interruptedReconciliation:{status:'complete',checkedAt:at,source:'erplain_api',externalWrites:0}};
    await tx.query("UPDATE orders SET erp_live=$2,erp_status='live_created' WHERE id=$1",[o.id,JSON.stringify(erp)]);
    await tx.query("UPDATE erp_live_jobs SET status='complete',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
    await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.interrupted_reconciled',$1)",[JSON.stringify({orderId:o.id,bcId:erp.bc.id,blId:erp.bl.id,stockId:erp.stockDocument.id,externalWrites:0})]);
    return {status:'complete',orderId:o.id};
   });
  },['stock-mutations']);}finally{running=false;}
 }
 return {run,get running(){return running;}};
}
