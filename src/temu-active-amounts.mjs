// Reconcile the financial history with explicit, fully cancelled TEMU lines.
// Raw API records stay untouched; no inferred cancellation or prorated refund.
export function confirmedCancelledTemuLine(line){
 const original=Number(line?.originalOrderQuantity),cancelled=Number(line?.canceledQuantityBeforeShipment);
 return typeof line?.orderSn==='string'&&line.orderSn.trim()!==''
  &&line.quantity!==null&&line.quantity!==undefined&&String(line.quantity).trim()!==''&&Number(line.quantity)===0
  &&Number.isSafeInteger(original)&&original>0&&cancelled===original;
}
export function temuActiveAmounts(order,raw){
 const detail=order.source_payload?.temuOrderDetail;
 if(!Array.isArray(raw?.orderList)||!Array.isArray(detail?.orderList))return raw;
 const cancelled=detail.orderList.filter(confirmedCancelledTemuLine),cancelledIds=new Set(cancelled.map(l=>String(l.orderSn)));
 const removed=raw.orderList.filter(l=>cancelledIds.has(String(l.orderSn)));
 if(!removed.length)return raw;
 const fail=message=>{throw Error('TEMU · Annulation partielle : '+message);};
 const parent=raw.parentOrderMap;
 if(parent?.parentOrderSn!==order.reference||detail.parentOrderMap?.parentOrderSn!==order.reference)fail('identité de commande incohérente');
 const indexed=list=>{const map=new Map();for(const l of list){const id=String(l.orderSn||'');if(!id||map.has(id))fail('référence de ligne absente ou dupliquée');map.set(id,l);}return map;};
 const details=indexed(detail.orderList),financial=indexed(raw.orderList);
 const active=raw.orderList.filter(l=>!cancelledIds.has(String(l.orderSn)));
 if(!active.length)fail('aucun article restant à préparer');
 for(const l of raw.orderList){
  const d=details.get(String(l.orderSn)),q=Number(l.quantity);
  if(!d)fail('ligne financière sans correspondance dans la commande');
  if(!Number.isSafeInteger(q)||q<=0)fail('quantité financière non vérifiable');
  if(cancelledIds.has(String(l.orderSn))){if(q!==Number(d.originalOrderQuantity))fail('quantité annulée différente de la ligne financière');}
  else if(q!==Number(d.quantity))fail('quantité active différente de la ligne financière');
 }
 for(const l of detail.orderList)if(!cancelledIds.has(String(l.orderSn))&&!financial.has(String(l.orderSn)))fail('prix d’un article actif absent');
 const currency=parent.basePriceTotal?.currency;
 if(!/^[A-Z]{3}$/.test(currency||''))fail('devise absente');
 const money=(v,label)=>{const text=String(v?.amount??'').trim();if(v?.currency!==currency||!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text)))fail(label+' absent ou incohérent');return Number(text);};
 const sum=(rows,field)=>{const total=rows.reduce((n,l)=>n+money(l[field],field),0);if(!Number.isSafeInteger(total))fail('montant trop élevé');return total;};
 for(const l of raw.orderList){
  if(money(l.shipTaxAmount,'TVA livraison')>money(l.shipAmountTotalTaxIncl,'Livraison TTC'))fail('TVA livraison supérieure aux frais');
  if(l.unitBasePrice&&money(l.unitBasePrice,'Prix unitaire')*Number(l.quantity)!==money(l.basePrice,'Prix produit'))fail('prix total différent du prix unitaire');
 }
 // The supported ledger carries the cancelled product's original net price and
 // an exactly matching seller deduction. Shipping is retained for active items.
 // A refund with separate cancelled shipping needs an explicit allocation.
 if(sum(removed,'shipAmountTotalTaxIncl')!==0||sum(removed,'shipTaxAmount')!==0)fail('frais de livraison annulés à rapprocher');
 const activeBase=sum(active,'basePrice'),cancelledBase=sum(removed,'basePrice');
 const base=money(parent.basePriceTotal,'Total produits'),deduction=parent.estimatedRevenueDeduction?money(parent.estimatedRevenueDeduction,'Retenue vendeur'):0;
 if(!((base===activeBase+cancelledBase&&deduction===cancelledBase)||(base===activeBase&&deduction===0)))fail('retenue vendeur différente du montant des articles annulés');
 const shippingGross=sum(active,'shipAmountTotalTaxIncl'),shippingTax=sum(active,'shipTaxAmount');
 const shippingNet=shippingGross-shippingTax,tax=sum(active,'productTaxAmount')+shippingTax;
 if(money(parent.shippingAmountTotal,'Total livraison HT')!==shippingNet)fail('total livraison différent des articles actifs');
 if(money(parent.taxTotal,'Total TVA')!==tax)fail('total TVA différent des articles actifs');
 const after=parent.taxTotalAfterDiscount?money(parent.taxTotalAfterDiscount,'TVA après remise'):tax;
 if(after>tax)fail('TVA après remise supérieure à la TVA des articles actifs');
 if(money(parent.estimatedRevenue,'Revenu vendeur')!==activeBase+shippingNet+after)fail('revenu vendeur différent des articles actifs');
 const result=structuredClone(raw),m=amount=>({amount,currency});
 result.orderList=result.orderList.filter(l=>!cancelledIds.has(String(l.orderSn)));
 result.parentOrderMap.basePriceTotal=m(activeBase);
 result.parentOrderMap.estimatedRevenueDeduction=m(0);
 // Customer retail fields do not participate in seller revenue validation.
 // Keep refunds and source totals in the immutable raw record and in this trace.
 result.v3CancelledLines={version:1,source:'temu_confirmed_cancellation',orderSns:removed.map(l=>String(l.orderSn)),currency,cancelledBase,coveredSellerDeduction:deduction,originalBaseTotal:base,originalParent:structuredClone(parent)};
 return result;
}
