import {erplainAccount} from './erplain-accounts.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {mutationBlock} from './erp-transient-policy.mjs';

const fields='id external_reference status total currency{label} paid_amount invoices_count tax_type line_items{id quantity price discount discount_rule_amount ecotax tax_codes{id}} shipping_orders(first:1){data{id} paginatorInfo{hasMorePages}}';
export function correctionInput(bc,source){
 compareMoney(bc,source);
 if(!['active','unpublished'].includes(bc.status)||bc.paid_amount==null||Number(bc.paid_amount)!==0||bc.invoices_count==null||Number(bc.invoices_count)!==0||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.data.length||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Correction réservée aux BC ouverts sans paiement, facture ni BL');
 if(!['inclusive','exclusive'].includes(bc.tax_type)||!bc.line_items?.length||Number(bc.total)<=0)throw Error('Base de prix du BC non vérifiable');
 const ratio=Number(source.amount)/Number(bc.total);
 return {line_items:bc.line_items.map(l=>{
  if(!l.id||l.price==null||!Number.isFinite(Number(l.price))||Number(l.price)<0||!(Number(l.quantity)>0)||!Array.isArray(l.tax_codes)||['discount','discount_rule_amount','ecotax'].some(k=>!Object.hasOwn(l,k)||l[k]!==null&&(!Number.isFinite(Number(l[k]))||Number(l[k])!==0)))throw Error('Prix, remises ou écotaxes du BC à vérifier manuellement');
  return {id:String(l.id),price:Number((Number(l.price)*ratio).toFixed(8)),tax_codes:l.tax_codes,apply_discount_rules:false};
 })};
}
import {comparePrices} from './price-verification.mjs';
function compareMoney(bc,source){return comparePrices({amount:bc.total,currency:bc.currency?.label},source);}

export function priceCorrection(db,directory,verification,{api=erplainAccount(directory,'live')}={}){
 return async function correct(input,user){
  if(typeof input.id!=='string'||!input.id||!input.bcId||!input.source||!input.bc)throw Error('Commande et comparaison requises');
  return withShipmentLock(async()=>{
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[input.id])).rows[0];
   const block=mutationBlock(o);if(block)throw Error(block);
   if(o.partial_mode||o.erp_live?.bl?.id)throw Error('Commande avec BL ou livraison partielle : correction manuelle requise');
   if(String(o.erp_live?.bc?.id)!==String(input.bcId))throw Error('BC modifié : relancez la vérification');
   if(o.erp_live?.priceCorrection?.status==='uncertain')throw Error('Correction précédente incertaine : rapprochez le BC Erplain avant toute nouvelle correction');
   const current=await verification.check(o,o.address?.country);
   if(current.status==='review')throw Error(current.error);
   if(comparePrices(current.source,input.source).status!=='same')throw Error('Prix plateforme modifié : relancez la vérification');
   await api.verify();
   const read=async()=>(await api.request(`query V3PriceCorrectionBC($id:ID!){Order(id:$id){${fields}}}`,{id:String(input.bcId)})).Order;
   const bc=await read();
   if(String(bc?.id)!==String(input.bcId)||bc.external_reference!==o.reference)throw Error('Identité du BC Erplain différente');
   if(compareMoney(bc,current.source).status==='same'){
    await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify({...o.erp_live.bc,...bc})]);
    return {...current,...compareMoney(bc,current.source)};
   }
   if(compareMoney(bc,input.bc).status!=='same')throw Error('Prix Erplain modifié : relancez la vérification');
   const patch=correctionInput(bc,current.source),at=new Date().toISOString();
   const mark=async status=>db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{priceCorrection}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify({status,at,source:current.source,user:user.email})]);
   await mark('uncertain');
   await db.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'price.correction.requested',$2)",[user.email,JSON.stringify({orderId:o.id,bcId:bc.id,before:bc.total,source:current.source})]);
   let mutationError;try{await api.request('mutation V3CorrectOrderPrice($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id}}',{id:String(bc.id),input:patch});}catch(e){mutationError=e;}
   const updated=await read();
   if(String(updated?.id)!==String(bc.id)||updated.external_reference!==o.reference||compareMoney(updated,current.source).status!=='same')throw Error('Correction non confirmée dans Erplain : rapprochement requis'+(mutationError?' · '+mutationError.message:''));
   await db.query("UPDATE orders SET erp_live=jsonb_set(jsonb_set(erp_live,'{bc}',$2::jsonb),'{priceCorrection}',$3::jsonb) WHERE id=$1",[o.id,JSON.stringify({...o.erp_live.bc,...updated}),JSON.stringify({status:'verified',at,source:current.source,user:user.email})]);
   return {...current,...compareMoney(updated,current.source)};
  });
 };
}
