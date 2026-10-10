import {temuCommercialSource,temuSellerTotals} from './temu-commercial-source.mjs';
import {temuCountryAmounts} from './temu-country-vat.mjs';
import {verifySourceCommercialTotals} from './bc-pricing.mjs';
export function sellerBcPlan(order,actual,codes){
 const source=temuSellerTotals(order);
 if(String(actual?.id)!==String(order.erp_live?.bc?.id))throw Error('Identité BC différente');
 try{return {action:'retain',source,confirmed:verifySourceCommercialTotals(actual,source)};}catch{}
 if(!['active','pending','unpublished'].includes(actual.status)||source.total===0)throw Error('Commande annulée ou statut commercial non modifiable');
 if(!['inclusive','exclusive'].includes(actual.tax_type)||typeof actual.update_stock!=='boolean'||actual.currency?.label!==source.currency)throw Error('Contexte commercial incomplet');
 if(actual.shipping_orders?.paginatorInfo?.hasMorePages)throw Error('Liste BL incomplète');
 const d=temuCommercialSource(order,temuCountryAmounts(order));
 const freight=d.orderList.reduce((s,l)=>s+Number(l.shipAmountTotalTaxIncl.amount),0);
 const target={normal:Math.round(source.total*100)-freight,shipping_cost:freight};
 const items=actual.line_items;if(!items?.length||items.some(l=>!['normal','shipping_cost'].includes(l.type)||!l.id||!(Number(l.quantity)>0)||!Number.isFinite(Number(l.price))||Number(l.price)<0||Number(l.discount)||Number(l.discount_rule_amount)||Number(l.ecotax)))throw Error('Lignes particulières à rapprocher');
 const prices=new Map();
 for(const type of ['normal','shipping_cost']){
  const group=items.filter(l=>l.type===type);if(!group.length){if(target[type])throw Error('Frais ou produits absents du BC');continue;}
  const weighted=group.map(l=>{const rates=(l.tax_codes||[]).map(t=>{const c=codes.find(c=>String(c.id)===String(t.id));if(!c||c.tax_rates?.length!==1)throw Error('Code TVA non vérifiable');return Number(c.tax_rates[0].rate);});if(rates.length>1)throw Error('TVA multiple');const rate=rates[0]||0;const allowed=d.orderList.map(x=>Number(type==='normal'?x.productTaxRate:x.shipTaxRate)/1e6);if(target[type]&&!allowed.includes(rate))throw Error('Taux TVA BC différent de la source vendeur');const gross=Number(l.price)*Number(l.quantity)*(actual.tax_type==='exclusive'?1+rate/100:1);return {l,rate,gross};});
  const sum=weighted.reduce((s,x)=>s+x.gross,0);if(!sum&&target[type])throw Error('Ventilation des prix existants impossible');
  let assigned=0;weighted.forEach((x,i)=>{const gross=i===weighted.length-1?target[type]-assigned:Math.round(target[type]*x.gross/sum)||0;assigned+=gross;const price=gross/100/Number(x.l.quantity)/(actual.tax_type==='exclusive'?1+x.rate/100:1);prices.set(String(x.l.id),Number(price.toFixed(8)));});
 }
 return {action:'update_prices',source,input:{line_items:items.map(l=>({id:String(l.id),price:prices.get(String(l.id))}))},allocation:'source seller freight; remaining seller revenue allocated by existing product gross proportions; quantities and tax codes preserved'};
}
