import {temuCountryAmounts} from './temu-country-vat.mjs';
import {acceptedMonetaryDifference,monetaryPolicy} from './monetary-policy.mjs';
import {temuActiveAmounts} from './temu-active-amounts.mjs';
import {manualSellerAmounts} from './temu-manual-commercial-source.mjs';
export const temuSellerPolicy='temu-estimatedRevenue-only-20261007';
// API seller revenue is authoritative when no manual seller entry exists.
// Customer retail/payment fields never enter this projection. Raw records stay immutable.
export function temuCommercialSource(order,fallback){
 if(order.source_payload?.temuManualPricing)return manualSellerAmounts(order,fallback||temuCountryAmounts(order));
 const api=order.source_payload?.temuAmounts?.data,revenue=api?.parentOrderMap?.estimatedRevenue;
 if(api?.parentOrderMap?.parentOrderSn!==order.reference || !/^[A-Z]{3}$/.test(revenue?.currency||'')
 || revenue?.amount==null || String(revenue.amount).trim()==='' || !Number.isSafeInteger(Number(revenue.amount)) || Number(revenue.amount)<0)
  throw Error('TEMU · Revenu vendeur estimé (estimatedRevenue) absent ou invalide dans l’API');
 const raw=temuActiveAmounts(order,api),p=raw.parentOrderMap,currency=revenue.currency,target=Number(revenue.amount);
 if(!Array.isArray(raw.orderList)||!raw.orderList.length)throw Error('TEMU · Détail du revenu vendeur absent');
 const read=(v,label)=>{if(v?.currency!==currency||v.amount==null||String(v.amount).trim()===''||!Number.isSafeInteger(Number(v.amount))||Number(v.amount)<0)throw Error('TEMU · Montant vendeur invalide : '+label);return Number(v.amount);};
 const rate=(v,label)=>{if(v==null||String(v).trim()===''||!Number.isFinite(Number(v))||Number(v)<0||Number(v)>100000000)throw Error('TEMU · Taux TVA absent : '+label);return Number(v);};
 const equal=(a,b)=>acceptedMonetaryDifference(a/100,b/100,{currency,total:target/100});
 const data=structuredClone(raw),parts=[];let base=0,ship=0,tax=0;
 for(const l of data.orderList){
  if(!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<=0)throw Error('TEMU · Quantité financière invalide');
  const b=read(l.basePrice,'produit'),t=read(l.productTaxAmount,'TVA produit'),s=read(l.shipAmountTotalTaxIncl,'livraison'),st=read(l.shipTaxAmount,'TVA livraison');
  if(st>s)throw Error('TEMU · TVA livraison supérieure au montant');
  const override=fallback?.v3VatPolicy?fallback.orderList.find(x=>String(x.orderSn)===String(l.orderSn)):null;
  parts.push({line:l,kind:'product',net:b,tax:t,rate:rate(override?.productTaxRate??l.productTaxRate,'produit')});
  parts.push({line:l,kind:'shipping',net:s-st,tax:st,rate:s||st?rate(override?.shipTaxRate??l.shipTaxRate,'livraison'):0});
  base+=b;ship+=s-st;tax+=t+st;
 }
 if(!equal(base,read(p.basePriceTotal,'total produits'))||!equal(ship,read(p.shippingAmountTotal,'total livraison')))throw Error('TEMU · Détail vendeur différent des totaux');
 const deduction=p.estimatedRevenueDeduction?read(p.estimatedRevenueDeduction,'retenue'):0;
 if(deduction)throw Error('TEMU · Retenue sur revenu à ventiler avant création du BC');
 const after=read(p.taxTotalAfterDiscount||p.taxTotal,'TVA après remise');
 if(after&&!tax)throw Error('TEMU · Ventilation de TVA impossible');
 const allocate=(total,weights)=>{const sum=weights.reduce((n,x)=>n+x,0);if(!sum){if(total)throw Error('TEMU · Ventilation du revenu vendeur impossible');return weights.map(()=>0);}const a=weights.map((w,i)=>({i,n:Math.floor(total*w/sum),fraction:total*w/sum-Math.floor(total*w/sum)}));let rest=total-a.reduce((n,x)=>n+x.n,0);for(const x of [...a].sort((x,y)=>y.fraction-x.fraction||x.i-y.i)){if(rest-->0)x.n++;}return a.map(x=>x.n);};
 const sourceTax=allocate(after,parts.map(x=>x.tax));
 const gross=parts.map((x,i)=>x.net+sourceTax[i]),sum=gross.reduce((n,x)=>n+x,0);
 if(!equal(sum,target))throw Error('TEMU · Détail du revenu vendeur différent de estimatedRevenue');
 const finalGross=sum===target?gross:allocate(target,gross),m=amount=>({amount,currency});
 let sellerBase=0,sellerShipping=0,sellerTax=0;
 for(let i=0;i<parts.length;i++){const x=parts[i],g=finalGross[i],t=Math.round(g*x.rate/(100000000+x.rate)),n=g-t;
  if(x.kind==='product'){x.line.basePrice=m(n);x.line.unitBasePrice=m(n/Number(x.line.quantity));x.line.productTaxAmount=m(t);x.line.productTaxRate=x.rate;sellerBase+=n;}
  else{x.line.shipAmountTotalTaxIncl=m(g);x.line.shipTaxAmount=m(t);x.line.shipTaxRate=x.rate;sellerShipping+=n;}
  sellerTax+=t;
 }
 data.parentOrderMap={...p,estimatedRevenue:structuredClone(revenue),basePriceTotal:m(sellerBase),shippingAmountTotal:m(sellerShipping),taxTotal:m(sellerTax),taxTotalAfterDiscount:m(sellerTax)};
 if(fallback?.v3VatPolicy)data.v3VatPolicy=structuredClone(fallback.v3VatPolicy);
 data.v3CommercialBasis={source:'temu_estimated_revenue',field:'estimatedRevenue',version:temuSellerPolicy,policy:monetaryPolicy,sourceEstimatedRevenue:structuredClone(revenue),sourceTaxAfterDiscount:p.taxTotalAfterDiscount,vatBasis:'seller_gross_at_source_rates',roundingAdjustment:target-sum};
 return data;
}

export function temuSellerTotals(order){const d=temuCommercialSource(order,temuCountryAmounts(order)),p=d.parentOrderMap;return {...order.erp_live?.pricing,total:Number(p.estimatedRevenue.amount)/100,tax:Number(p.taxTotalAfterDiscount.amount)/100,currency:p.estimatedRevenue.currency,commercialBasis:d.v3CommercialBasis};}
