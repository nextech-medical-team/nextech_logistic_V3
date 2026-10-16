import {usesRecordedBc} from './existing-bc-execution.mjs';
import {createHash} from 'node:crypto';

import {readHistoricalStock,assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';

import {verifyBcPricing,verifySourceCommercialTotals} from './bc-pricing.mjs';

import {assertFullOrderStock} from './stock-gate.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';



const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const alignmentFields='id label created_at external_reference status update_stock total paid_amount invoices_count tax_type currency{label} line_items{id type quantity price discount discount_rule_amount ecotax tax_amount tax_codes{id} location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}';

export function mappedDocumentQuantities(items){

 const totals=new Map();

 for(const l of shippingProductLines(items)){

  if(!l.variant?.id||!l.location?.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)throw Error('Ligne BC non vérifiable');

  const key=String(l.variant.id)+':'+String(l.location.id);totals.set(key,(totals.get(key)||0)+Number(l.quantity));

 }

 return [...totals].sort();

}

export async function assertAdditionalMappingStock(api,bc,items){
 if(bc.update_stock!==true)return;
 const existing=new Map(mappedDocumentQuantities(bc.line_items));
 for(const [key,quantity] of mappedDocumentQuantities(items)){
  const additional=quantity-(existing.get(key)||0);if(additional<=1e-6)continue;
  const [id,locationId]=key.split(':');
  const {Variant:v}=await api.request('query V3MappingAdditionalStock($id:ID!){Variant(id:$id){id sku active track_inventory product{id active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}}}',{id});
  if(String(v?.id)!==id||v.active!==true||v.product?.active!==true||typeof v.track_inventory!=='boolean')throw Error('Additional mapping stock identity not confirmed');
  if(v.track_inventory===false)continue;
  if(!Array.isArray(v.stock_levels?.data)||v.stock_levels.paginatorInfo?.hasMorePages!==false)throw Error('Additional mapping stock response incomplete');
  const levels=v.stock_levels.data.filter(l=>String(l.location?.id)===locationId);if(levels.length!==1)throw Error('Additional mapping stock location not confirmed');
  assertFullOrderStock([{variant:v,location:{id:locationId},quantity:additional,available:levels[0].available,on_hand:levels[0].on_hand,reserved_quantity:0}],{preserveInstalled:true});
 }
}
// Uses the normal Erplain BC edit. Erplain owns its stock adjustment; V3 never

// issues a separate stock restitution/debit here. A lost response is read back,

// and an uncertain recorded mutation is never submitted a second time.

export async function alignMappedBc(api,o,{save,guard,preserveLabels}){
 if(usesRecordedBc(o)){if(o.erp_live?.mappingAlignmentAttempt?.status==='uncertain')throw Error('BC · Modification incertaine : rapprochement requis, aucune réécriture');return {unchanged:true,authority:'recorded_erplain_bc',sourceAlignmentDisabled:true};}

 if(!o.erp_live?.bc?.id||o.erp_live.bl?.id||o.partial_mode||o.erp_live.equivalentItems||o.source_payload?.erplainImported)return {skipped:true};

 const {Order:bc}=await api.request(`query V3MappingBC($id:ID!){Order(id:$id){${alignmentFields}}}`,{id:String(o.erp_live.bc.id)});

 if(String(bc?.id)!==String(o.erp_live.bc.id))throw Error('BC demandé non reçu pour alignement du mapping');

 if(bc.status!=='active'||bc.external_reference!==o.reference||typeof bc.update_stock!=='boolean')throw Error('BC actif : identité et politique de stock non confirmées');

 const actual=mappedDocumentQuantities(bc.line_items),desired=mappedDocumentQuantities(o.items);

 if(JSON.stringify(actual)===JSON.stringify(desired)){

  if(o.erp_live.mappingAlignmentAttempt?.status==='uncertain'){

   if(o.erp_live.mappingAlignmentAttempt.target!==digest(desired)||bc.update_stock!==o.erp_live.mappingAlignmentAttempt.stockPolicy)throw Error('Cible du rapprochement BC incertain non confirmée');

   verifyBcPricing(bc,o.pricing);

   if(bc.update_stock===true)await readHistoricalStock(api,bc,{additionalVariants:o.erp_live.mappingAlignmentAttempt.previousVariants});

   o.erp_live.mappingAlignmentAttempt.status='verified';await save(o);

  }

  return {unchanged:true};

 }

 if(o.erp_live.mappingAlignmentAttempt?.status==='uncertain')throw Error('Alignement BC incertain : résultat fournisseur à rapprocher, aucune réécriture');

 if(bc.status!=='active'||bc.external_reference!==o.reference||Number(bc.invoices_count)!==0||Number(bc.paid_amount)!==0||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length||typeof bc.update_stock!=='boolean')throw Error('Alignement mapping : BC actif sans facture ni BL requis');

 if(!o.pricing?.items?.length)throw Error('Alignement mapping : prix source vérifiés requis');

 verifySourceCommercialTotals(bc,o.pricing);

 const previousVariants=[...new Set(shippingProductLines(bc.line_items).map(l=>String(l.variant.id)))];

 if(bc.update_stock===true){await assertNoHistoricalStockRemoval(api,o);await readHistoricalStock(api,bc);}

 await assertAdditionalMappingStock(api,bc,o.items);
 await guard();
 if(typeof preserveLabels!=='function')throw Error('Conservation des etiquettes existantes non verifiable avant alignement BC');
 await preserveLabels();await guard();

 o.erp_live.mappingAlignmentAttempt={status:'uncertain',before:digest(actual),target:digest(desired),previousVariants,requestedAt:new Date().toISOString(),stockPolicy:bc.update_stock};await save(o);

 const neutralFreight=o.pricing.items.some(l=>l.type==='shipping_cost')?[]:bc.line_items.filter(l=>l.type==='shipping_cost'&&Number(l.quantity)===1&&l.price!=null&&Number(l.price)===0&&l.tax_amount!=null&&Number(l.tax_amount)===0&&['discount','discount_rule_amount','ecotax'].every(k=>Object.hasOwn(l,k)&&(l[k]===null||Number(l[k])===0))).map(l=>({id:String(l.id),type:'shipping_cost',quantity:1,price:0,tax_codes:l.tax_codes}));

 const {UpdateOrder:updated}=await api.request(`mutation V3AlignMappedBC($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){${alignmentFields}}}`,{id:String(bc.id),input:{tax_type:o.pricing.tax_type,line_items:[...o.pricing.items,...neutralFreight]}});

 if(String(updated?.id)!==String(bc.id)||updated.update_stock!==bc.update_stock||JSON.stringify(mappedDocumentQuantities(updated.line_items))!==JSON.stringify(desired)||updated.shipping_orders?.paginatorInfo?.hasMorePages!==false||updated.shipping_orders.data.length)throw Error('Alignement BC non confirmé : rapprochement requis');

 verifyBcPricing(updated,o.pricing);

 if(bc.update_stock===true)await readHistoricalStock(api,updated,{additionalVariants:previousVariants});

 o.erp_live.mappingAlignmentAttempt.status='verified';o.erp_live.mappingAlignmentAttempt.verifiedAt=new Date().toISOString();await save(o);

 return {aligned:true,bcId:String(bc.id),stockAdjustedByErplain:true};

}

