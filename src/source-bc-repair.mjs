import {usesRecordedBc,recordedBcPricing,readRecordedBc} from './existing-bc-execution.mjs';
import {buildBcPricing,verifyBcPricing,verifySourceCommercialTotals} from './bc-pricing.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
export function sourceRepairPlan(o,lines,actual,codes){
 if(usesRecordedBc(o))return recordedBcPricing(o,actual);
 if(o.partial_mode||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id||o.erp_live?.stockCreationAttemptedAt
 ||!['active','pending','unpublished'].includes(actual?.status)||actual.update_stock!==false
 ||actual.shipping_orders?.paginatorInfo?.hasMorePages||!Array.isArray(actual.shipping_orders?.data)||actual.shipping_orders.data.length)
 throw Error('BC · Documents existants : rapprochement commercial requis avant correction');
 const normal=actual.line_items?.filter(l=>l.type==='normal');
 if(!normal||normal.length!==lines.length||!['inclusive','exclusive'].includes(actual.tax_type)||actual.line_items.some(l=>!['normal','shipping_cost'].includes(l.type)||!l.id||l.price==null||!Number.isFinite(Number(l.price))||Number(l.price)<0||l.tax_amount==null||!Number.isFinite(Number(l.tax_amount))||Number(l.quantity)<=0||Number(l.discount)||Number(l.discount_rule_amount)||Number(l.ecotax)))throw Error('BC · Lignes particulières : rapprochement commercial requis');
 const used=new Set(),products=lines.map(l=>{
  const sku=l.target_sku||l.mapped_sku||l.source_sku;
  const quantity=Number(l.target_quantity??(Number(l.source_qty)>0?Number(l.quantity)*Number(l.target_qty)/Number(l.source_qty):l.quantity));
  const hit=normal.filter(x=>x.variant?.sku===sku&&Number(x.quantity)===quantity&&!used.has(String(x.id)));
  if(hit.length!==1||!hit[0].location?.id)throw Error('BC · Produit ou quantité différent : rapprochement requis');
  const a=hit[0];used.add(String(a.id));return {id:String(a.id),variant:{id:String(a.variant.id)},location:{id:String(a.location.id)},quantity,description:sku};
 });
 const pricing=buildBcPricing(o,lines,products,codes,{eurExchangeRate:o.erp_live?.pricing?.eurExchangeRate});
 if(actual.currency?.label!==pricing.currency)throw Error('BC · Devise Erplain différente de la source : rapprochement requis');
 // Preserve all commercial line identities, including freight.
 const freight=actual.line_items.filter(l=>l.type==='shipping_cost'),desired=pricing.items.filter(l=>l.type==='shipping_cost');
 if(freight.length!==desired.length)throw Error('BC · Frais de livraison différents : rapprochement requis');
 let n=0;pricing.items=pricing.items.map(l=>l.type==='shipping_cost'?{...l,id:String(freight[n++].id)}:l);
 return pricing;
}
export async function repairUnpreparedSourceBc(db,api,o,source){
 if(usesRecordedBc(o))return (await readRecordedBc(api,o)).pricing.confirmed;
 return withShipmentLock(async()=>{
  const current=(await db.query("SELECT o.*,j.error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id WHERE o.id=$1 AND j.status='review'",[o.id])).rows[0];
  if(!current||current.error!==o.error||JSON.stringify(current.erp_live)!==JSON.stringify(o.erp_live)||JSON.stringify(current.source_payload)!==JSON.stringify(o.source_payload))throw Error('BC · Commande modifiée pendant le rapprochement');
  const busy=(await db.query(`SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')
   UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (result IS NOT NULL OR jsonb_array_length(tracking)>0 OR status IN ('pending','creating','awaiting_pdf','ready'))
   UNION ALL SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0)` ,[o.id,o.reference])).rows.length;
  if(busy)throw Error('BC · Traitement ou étiquette existante : correction commerciale différée');
  const fields='id label status total tax_type update_stock currency{label} line_items{id type quantity price tax_amount discount discount_rule_amount ecotax variant{id sku} location{id} tax_codes{id}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}';
  const actual=(await api.request(`query V3RepairSourceBC($id:ID!){Order(id:$id){${fields}}}`,{id:String(o.erp_live.bc.id)})).Order;
  if(String(actual?.id)!==String(o.erp_live.bc.id))throw Error('BC · Identité Erplain différente');
  const codes=(await api.request('query V3RepairTaxes {TaxCodes(first:200){data{id active tax_rates{rate}} paginatorInfo{hasMorePages}}}')).TaxCodes;
  if(!codes?.data||codes.paginatorInfo?.hasMorePages)throw Error('BC · Catalogue TVA incomplet');
  const lines=(await db.query('SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1 ORDER BY l.source_line',[o.id,o.channel])).rows;
  const pricing=sourceRepairPlan(o,lines,actual,codes.data);
  const claimed=await db.transaction(async tx=>{
   const latest=(await tx.query("SELECT o.*,j.error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id WHERE o.id=$1 AND j.status='review' FOR UPDATE OF o,j",[o.id])).rows[0];
   if(!latest||latest.error!==o.error||JSON.stringify(latest.erp_live)!==JSON.stringify(o.erp_live)||JSON.stringify(latest.source_payload)!==JSON.stringify(o.source_payload))return false;
   if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[o.id])).rows.length)return false;
   await tx.query("UPDATE erp_live_jobs SET status='processing',updated_at=now() WHERE order_id=$1",[o.id]);return true;
  });
  if(!claimed)throw Error('BC · Rapprochement concurrent : correction différée');
  // No attempt is replayed after an uncertain response. A later pass first reads the same BC.
  try{
   await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.source_price_repair_requested',$1)",[JSON.stringify({orderId:o.id,bcId:actual.id,originalTotal:actual.total,sourceTotal:source.total})]);
   await api.verify();
   const changed=(await api.request(`mutation V3RepairSourceBC($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){${fields}}}`,{id:String(actual.id),input:{tax_type:'exclusive',line_items:pricing.items}})).UpdateOrder;
   if(String(changed?.id)!==String(actual.id)||changed.label!==actual.label)throw Error('BC · Correction non confirmée : relire le même BC avant reprise');
   verifyBcPricing(changed,pricing);return verifySourceCommercialTotals(changed,source);
  }finally{await db.query("UPDATE erp_live_jobs SET status='review',updated_at=now() WHERE order_id=$1 AND status='processing'",[o.id]);}
 },['stock-mutations','order:'+o.id,'temu-order:'+o.reference]);
}
