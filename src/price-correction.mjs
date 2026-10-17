import {erplainAccount} from './erplain-accounts.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {mutationBlock} from './erp-transient-policy.mjs';
import {assertOrderIdle} from './order-suspension.mjs';
import {randomUUID} from 'node:crypto';

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
function guard(order,input,initial,attempt){
 const block=mutationBlock(order);if(block)throw Error(block);
 if(order.partial_mode||order.erp_live?.bl?.id)throw Error('Commande avec BL ou livraison partielle : correction manuelle requise');
 if(String(order.erp_live?.bc?.id)!==String(input.bcId))throw Error('BC modifié : relancez la vérification');
 if(initial&&JSON.stringify([order.reference,order.channel,order.address,order.source_payload])!==JSON.stringify([initial.reference,initial.channel,initial.address,initial.source_payload]))throw Error('Source de la commande modifiée : relancez la vérification');
 const previous=order.erp_live?.priceCorrection;
 if(attempt ? previous?.attempt!==attempt||previous.status!=='uncertain' : previous?.status==='uncertain')throw Error('Correction précédente incertaine : rapprochez le BC Erplain avant toute nouvelle correction');
}

export function priceCorrection(db,directory,verification,{api=erplainAccount(directory,'live')}={}){
 return async function correct(input,user){
  if(typeof input.id!=='string'||!input.id||!input.bcId||!input.source||!input.bc)throw Error('Commande et comparaison requises');
  return withShipmentLock(async()=>{
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[input.id])).rows[0];
   guard(o,input);
   const current=await verification.check(o,o.address?.country);
   if(current.status==='review')throw Error(current.error);
   if(comparePrices(current.source,input.source).status!=='same')throw Error('Prix plateforme modifié : relancez la vérification');
   await api.verify();
   const read=async()=>(await api.request(`query V3PriceCorrectionBC($id:ID!){Order(id:$id){${fields}}}`,{id:String(input.bcId)})).Order;
   const at=new Date().toISOString(),attempt=randomUUID(),state={status:'uncertain',attempt,at,source:current.source,user:user.email};
   // Commit uncertainty before any supplier mutation; a later rollback or process
   // interruption must never make an already-sent request eligible for replay.
   await db.transaction(async tx=>{
    const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE NOWAIT',[o.id])).rows[0];
    guard(fresh,input,o);await assertOrderIdle(tx,fresh);
    await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{priceCorrection}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(state)]);
   });
   return db.transaction(async tx=>{
    // Suspension and job admission use this same order row. Keep it locked until
    // readback so neither can cross the financial mutation after our final guard.
    const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE NOWAIT',[o.id])).rows[0];
    guard(fresh,input,o,attempt);await assertOrderIdle(tx,fresh);
    const bc=await read();
    if(String(bc?.id)!==String(input.bcId)||bc.external_reference!==fresh.reference)throw Error('Identité du BC Erplain différente');
    let updated=bc;
    if(compareMoney(bc,current.source).status!=='same'){
     if(compareMoney(bc,input.bc).status!=='same')throw Error('Prix Erplain modifié : relancez la vérification');
     const patch=correctionInput(bc,current.source);
     await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'price.correction.requested',$2)",[user.email,JSON.stringify({orderId:o.id,bcId:bc.id,before:bc.total,source:current.source,attempt})]);
     let mutationError;try{await api.request('mutation V3CorrectOrderPrice($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id}}',{id:String(bc.id),input:patch});}catch(e){mutationError=e;}
     updated=await read();
     if(String(updated?.id)!==String(bc.id)||updated.external_reference!==fresh.reference||compareMoney(updated,current.source).status!=='same')throw Error('Correction non confirmée dans Erplain : rapprochement requis'+(mutationError?' · '+mutationError.message:''));
    }
    await tx.query("UPDATE orders SET erp_live=jsonb_set(jsonb_set(erp_live,'{bc}',$2::jsonb),'{priceCorrection}',$3::jsonb) WHERE id=$1",[o.id,JSON.stringify({...fresh.erp_live.bc,...updated}),JSON.stringify({...state,status:'verified'})]);
    return {...current,...compareMoney(updated,current.source)};
   });
  });
 };
}
