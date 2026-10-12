import {createHash} from 'node:crypto';
// Human decision 2026-10-12: persisted seller HT prices are authoritative.
// Keep API observations immutable and record this separate commercial basis.
export function manualSellerAmounts(order,data){
 const manual=order.source_payload?.temuManualPricing;
 if(!manual)return null;
 const fail=message=>{throw Error('TEMU · Prix vendeur saisis à vérifier : '+message);};
 if(order.channel!=='temu'||manual.source!=='manual_user'||!Number.isFinite(Date.parse(manual.at)))fail('origine de la saisie');
 if(!data?.v3VatPolicy||data.v3VatPolicy.source!=='manual_user'&&manual.vatRate!==undefined)fail('TVA');
 if(data?.parentOrderMap?.parentOrderSn!==order.reference||!Array.isArray(data.orderList)||!data.orderList.length)fail('identité ou lignes');
 const currency=data.parentOrderMap.basePriceTotal?.currency;
 if(!/^[A-Z]{3}$/.test(currency||''))fail('devise');
 const read=(v,name)=>{if(v?.currency!==currency||!['string','number'].includes(typeof v.amount)||!/^\d+$/.test(String(v.amount))||!Number.isSafeInteger(Number(v.amount)))fail(name);return Number(v.amount);};
 // Validate saved primitives before the VAT projection can normalize them.
 if(!Array.isArray(manual.data?.orderList))fail('lignes enregistrées');
 for(const l of manual.data.orderList){
  const net=read(l.basePrice,'prix HT enregistré'),unit=read(l.unitBasePrice,'prix unitaire enregistré'),gross=read(l.shipAmountTotalTaxIncl,'livraison enregistrée'),st=read(l.shipTaxAmount,'TVA livraison enregistrée');
  if(unit*Number(l.quantity)!==net||st>gross)fail('total enregistré');
 }
 const seen=new Set();let base=0,shipping=0,tax=0;
 for(const l of data.orderList){
  if(typeof l.orderSn!=='string'||!l.orderSn||seen.has(l.orderSn))fail('référence de ligne');seen.add(l.orderSn);
  if(!['number','string'].includes(typeof l.quantity)||!/^\d+$/.test(String(l.quantity))||!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<=0)fail('quantité');
  const net=read(l.basePrice,'prix HT'),unit=read(l.unitBasePrice,'prix unitaire HT'),gross=read(l.shipAmountTotalTaxIncl,'livraison TTC'),st=read(l.shipTaxAmount,'TVA livraison'),pt=read(l.productTaxAmount,'TVA produit');
  if(unit*Number(l.quantity)!==net||st>gross)fail('total de ligne');
  base+=net;shipping+=gross-st;tax+=pt+st;
 }
 const p=data.parentOrderMap;
 if(base!==read(p.basePriceTotal,'total HT')||shipping!==read(p.shippingAmountTotal,'total livraison')||tax!==read(p.taxTotal,'total TVA')||tax!==read(p.taxTotalAfterDiscount,'total TVA après remise'))fail('totaux');
 const total=base+shipping+tax;if(!Number.isSafeInteger(total))fail('total trop élevé');
 const result=structuredClone(data),money={amount:total,currency};
 result.parentOrderMap.estimatedRevenue=money;
 result.v3CommercialBasis={source:'temu_manual_seller',field:'manualSellerTotal',version:'temu-manual-seller-20261012',sourceManualTotal:structuredClone(money),manualAt:manual.at,manualFingerprint:createHash('sha256').update(JSON.stringify(manual)).digest('hex'),vatBasis:'seller_net_at_manual_rate'};
 return result;
}
