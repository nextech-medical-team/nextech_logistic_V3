import {temuActiveAmounts} from './temu-active-amounts.mjs';
// Business rule approved 2026-10-06: TEMU sales to HR/SE use 25%.
// Source financial data stay immutable. Persisted seller entries take precedence
// under the human decision of 2026-10-12; never substitute catalogue prices.
export function temuFixedVat(order){
 if(order?.channel!=='temu')return null;
 const country=String(order.address?.country||order.source_payload?.country||'').trim().toUpperCase();
 return ['HR','SE'].includes(country)?25:null;
}
export function validateManualVat(value){
 const text=String(value??'').trim().replace(',','.');
 if(!/^\d+(?:\.\d{1,2})?$/.test(text)||Number(text)>100)throw Error('TVA : saisir un taux entre 0 et 100 % (deux décimales maximum)');
 return Number(text);
}
export function temuCountryAmounts(order,raw=order.source_payload?.temuManualPricing?.data||order.source_payload?.temuAmounts?.data,options={}){
 if(!raw)throw Error('TEMU · Revenu vendeur estimé (estimatedRevenue) absent de l’API');
 raw=temuActiveAmounts(order,raw);
 if(temuFixedVat(order)===null)return raw;
 const manualRate=options.vatRate??order.source_payload?.temuManualPricing?.vatRate;
 const rate=manualRate===undefined?25:validateManualVat(manualRate),factor=1+rate/100;
 const fail=field=>{throw Error('TEMU · '+field+' manquant ou incohérent · TVA '+rate+' % '+(manualRate===undefined?'appliquée automatiquement':'saisie manuellement'));};
 if(!raw?.parentOrderMap||raw.parentOrderMap.parentOrderSn!==order.reference||!raw.orderList?.length)fail('Prix et frais de livraison de la commande');
 const data=structuredClone(raw),parent=data.parentOrderMap;
 const currency=parent.basePriceTotal?.currency;
 if(!/^[A-Z]{3}$/.test(currency||''))fail('Devise');
 const read=(value,field)=>{if(value?.currency!==currency||value.amount===null||value.amount===undefined||String(value.amount).trim()===''||!Number.isSafeInteger(Number(value.amount))||Number(value.amount)<0)fail(field);return Number(value.amount);};
 const money=amount=>({amount,currency});
 const retail=false; // Seller base only; customer retail prices never price a TEMU BC.
 const baseTotal=retail?data.orderList.reduce((n,l)=>n+read(l.unitRetailPriceVatExcl,'Prix client HT')*Number(l.quantity),0):read(parent.basePriceTotal,'Total produits HT');
 parent.basePriceTotal=money(baseTotal);
 // A seller deduction needs a documented price allocation, never a guessed tax.
 if(parent.estimatedRevenueDeduction&&read(parent.estimatedRevenueDeduction,'Retenue vendeur')!==0)fail('Ventilation de la retenue vendeur');
 let base=0,shipping=0,tax=0;
 for(const line of data.orderList){
  const b=retail?read(line.unitRetailPriceVatExcl,'Prix client HT')*Number(line.quantity):read(line.basePrice,'Prix produit HT');
  line.basePrice=money(b);if(retail)line.unitBasePrice=money(read(line.unitRetailPriceVatExcl,'Prix client HT'));
  const gross=read(line.shipAmountTotalTaxIncl,'Frais de livraison TTC');
  const shippingTax=Math.round(gross-gross/factor),productTax=Math.round(b*rate/100);
  line.productTaxRate=Math.round(rate*1000000);line.shipTaxRate=Math.round(rate*1000000);
  line.productTaxAmount=money(productTax);line.shipTaxAmount=money(shippingTax);
  if(line.unitRetailPriceVatExcl){const retail=read(line.unitRetailPriceVatExcl,'Prix de vente HT');line.unitRetailPriceVatIncl=money(retail+Math.round(retail*rate/100));}
  base+=b;shipping+=gross-shippingTax;tax+=productTax+shippingTax;
 }
 if(base!==baseTotal)fail('Total des prix produits HT');
 parent.shippingAmountTotal=money(shipping);parent.taxTotal=money(tax);
 parent.taxTotalAfterDiscount=money(tax); // Preserve API estimatedRevenue.
 if(order.source_payload?.temuAmounts?.data?.parentOrderMap?.estimatedRevenue)parent.estimatedRevenue=structuredClone(order.source_payload.temuAmounts.data.parentOrderMap.estimatedRevenue);
 data.v3VatPolicy={rate,country:String(order.address?.country||order.source_payload?.country).toUpperCase(),source:manualRate===undefined?'user_country_rule':'manual_user',basis:'source_product_net_and_shipping_gross',version:2};
 return data;
}
