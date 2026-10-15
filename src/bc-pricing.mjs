import {temuDestinationVat} from './temu-destination-vat.mjs';
import {isTemuExcel,excelAmounts} from './temu-excel-commercial.mjs';
import {acceptedMonetaryDifference} from './monetary-policy.mjs';
export {acceptedMonetaryDifference} from './monetary-policy.mjs';
import {temuCommercialSource} from './temu-commercial-source.mjs';
import {temuCountryAmounts,temuFixedVat} from './temu-country-vat.mjs';
// Commercial amounts are source totals, never catalogue prices or converted unit counts.
const present=v=>v!==null&&v!==undefined&&String(v).trim()!=='';
// Financial values must be decimal primitives. Number() alone also accepts
// booleans, arrays and hexadecimal strings, which are not received amounts.
const decimalNumber=v=>['number','string'].includes(typeof v)&&/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(v).trim())&&Number.isFinite(Number(v))&&Number(v)>=0;
export function amount(v,field){
 if(!['number','string'].includes(typeof v)||!present(v)||!/^\d+(?:[.,]\d+)?$/.test(String(v).trim()))throw Error('BC · '+field+' absent ou invalide');
 const n=Number(String(v).trim().replace(',','.'));if(!Number.isFinite(n))throw Error('BC · '+field+' invalide');return n;
}
const cents=n=>Math.round((n+Number.EPSILON)*100);
const optional=(v,f)=>present(v)?amount(v,f):0;
export const sourceCurrency=o=>isTemuExcel(o)?o.source_payload?.temuExcelCommercial?.currency||o.source_payload?.currency||'EUR':String((o.channel==='temu'?o.source_payload?.temuAmounts?.data?.parentOrderMap?.estimatedRevenue?.currency:null)||o.source_payload?.currency||o.source_payload?.devise||'EUR').toUpperCase();
function taxCode(rate,codes){
 if(rate===0)return [];
 const hits=codes.filter(c=>c.active!==false&&Array.isArray(c.tax_rates)&&c.tax_rates.length===1&&Math.abs(Number(c.tax_rates[0].rate)-rate)<0.00001);
 if(hits.length!==1)throw Error('BC · TVA '+rate+' % absente ou ambiguë dans Erplain LIVE');
 return [{id:String(hits[0].id)}];
}
export function rateFromTax(net,tax,codes,country,context={}){
 if(tax===0)return 0;
 const rates=[...new Set(codes.flatMap(c=>c.active!==false&&c.tax_rates?.length===1?[Number(c.tax_rates[0].rate)]:[]))];
 const exact=rates.filter(r=>cents(net*r/100)===cents(tax));
 if(context.preferExactRate&&exact.length===1)return exact[0];
 if(context.preferExactRate&&exact.length>1)throw Error('BC · Taux de TVA source à préciser');
 const hits=rates.filter(r=>Math.abs(cents(net*r/100)-cents(tax))<=1);
 if(hits.length>1&&['FR','FRA','FRANCE'].includes(String(country||'').trim().toUpperCase())&&hits.includes(20))return 20;
 if(hits.length===1)return hits[0];
 if(hits.length>1)throw Error('BC · Taux de TVA source à préciser');
 const candidates=rates.filter(r=>Number.isFinite(r)&&r>=0&&acceptedMonetaryDifference(cents(net*r/100)/100,tax,context)).map(r=>({r,gap:Math.abs(cents(net*r/100)-cents(tax))})).sort((a,b)=>a.gap-b.gap);
 if(!candidates.length||candidates[1]?.gap===candidates[0].gap)throw Error('BC · Taux de TVA source à préciser');return candidates[0].r;
}
export function buildBcPricing(order,lines,products,codes,{eurExchangeRate,preferExactRate=false}={}){
 if(isTemuExcel(order)){
  const amounts=excelAmounts(lines,{country:order.address?.country});
  if(!lines.length||lines.length!==products.length)throw Error('BC · Lignes de prix incomplètes');
  const items=[],lineAmounts=[];
  const append=(product,gross,taxCodes,rate)=>{
   const quantity=Number(product.quantity);if(!Number.isFinite(quantity)||quantity<=0)throw Error('BC · Quantité du prix invalide');
   const tax=cents(gross*rate/(100+rate))/100,price=gross/quantity;
   items.push({...product,price,tax_codes:taxCodes,apply_discount_rules:false});
   lineAmounts.push({type:product.type||'normal',variantId:String(product.variant?.id||''),quantity,taxCodes:taxCodes.map(t=>String(t.id)).sort(),unitPrice:price,gross,tax,rate,basis:'gross',grossDecimal:decimalTotal(gross,1),grossCalculation:{unit:gross,quantity:1,discounts:[],additions:[]}});
  };
  products.forEach((product,i)=>{
   const {rate}=temuDestinationVat(order),taxCodes=taxCode(rate,codes),r=amounts.rows[i];
   append(product,cents(r.net+r.tax)/100,taxCodes,rate);
   const shipping=cents(r.shipping+r.shippingTax)/100;
   if(shipping)append({type:'shipping_cost',description:'Livraison TEMU · '+lines[i].source_sku,quantity:1},shipping,taxCodes,rate);
  });
  return {version:2,currency:amounts.currency,eurExchangeRate,tax_type:'inclusive',total:amounts.total,sourceLinesTotal:amounts.total,tax:cents(lineAmounts.reduce((sum,l)=>sum+l.tax,0))/100,items,lineAmounts,source:'temu_excel',taxPolicy:temuDestinationVat(order).policy,commercialBasis:{source:'temu_excel'},excel:amounts};
 }
 if(!lines.length||lines.length!==products.length)throw Error('BC · Lignes de prix incomplètes');
 if([...lines,...products].some(l=>!decimalNumber(l?.quantity)||Number(l.quantity)<=0))throw Error('BC · Quantité du prix source absente ou invalide');
 const src=order.source_payload||{},currency=sourceCurrency(order);
 const equal=(a,b)=>acceptedMonetaryDifference(a,b,{currency,eurExchangeRate,total:expected});
 const entries=[],commercialObservations=[];
 function add(product,gross,tax,rate,label,basis='net',grossCalculation={unit:gross,quantity:1,discounts:[],additions:[]},preferredCodes=null){
  if(!Number.isFinite(gross)||gross<0||!Number.isFinite(tax)||tax<0||tax>gross)throw Error('BC · Montants incohérents : '+label);
  const quantity=product?.quantity||1;
  const tax_codes=preferredCodes??taxCode(rate,codes),appliedRate=tax_codes.length?Number(codes.find(c=>String(c.id)===tax_codes[0].id).tax_rates[0].rate):0;
  const grossDecimal=decimalTotal(grossCalculation.unit,grossCalculation.quantity,grossCalculation.discounts,grossCalculation.additions);
  entries.push({item:{...(product||{type:'shipping_cost',description:label,quantity:1}),price:(gross-tax)/quantity,tax_codes,apply_discount_rules:false},gross,tax,rate:appliedRate,basis,grossDecimal,grossCalculation});
 }
 let expected;
 if(order.channel==='temu'){
  const data=temuCommercialSource(order,temuCountryAmounts(order)),parent=data?.parentOrderMap;
  if(parent?.parentOrderSn!==order.reference||!Array.isArray(data?.orderList))throw Error('TEMU · Prix API à récupérer avant création du BC');
  function money(v,label){if(v?.currency!==currency)throw Error('TEMU · Devise incohérente : '+label);return amount(v?.amount,label)/100;}
  expected=money(parent.estimatedRevenue,'Revenu vendeur estimé');
  const used=new Set();let base=0,taxTotal=0,shipping=0;
  lines.forEach((l,i)=>{
   const key=String(l.source_payload?.temuOrderSn||l.source_line),hits=data.orderList.filter(x=>String(x.orderSn)===key);
   if(hits.length!==1||used.has(key))throw Error('TEMU · Prix de ligne absent ou ambigu : '+l.source_sku);used.add(key);
   const x=hits[0];if(!decimalNumber(x.quantity)||Number(x.quantity)!==Number(l.quantity))throw Error('TEMU · Quantité du prix incohérente : '+l.source_sku);
   const b=money(x.basePrice,'Prix produit'),t=money(x.productTaxAmount,'TVA produit'),s=money(x.shipAmountTotalTaxIncl,'Livraison'),st=money(x.shipTaxAmount,'TVA livraison');
   if(x.unitBasePrice&&!equal(money(x.unitBasePrice,'Prix unitaire')*Number(l.quantity),b))commercialObservations.push({code:'source_unit_total_difference',sku:l.source_sku,blocking:false});
   // The seller-revenue projection derives net/tax cents from allocated gross
   // revenue. Those derived net cents are not an original net-price authority.
   const basis=data.v3CommercialBasis?.source==='temu_estimated_revenue'&&data.v3CommercialBasis?.vatBasis==='seller_gross_at_source_rates'?'gross':'net';
   add(products[i],b+t,t,amount(x.productTaxRate,'Taux TVA produit')/1000000,l.source_sku,basis,{unit:b,quantity:1,discounts:[],additions:[t]});
   if(s||st)add(null,s,st,amount(x.shipTaxRate,'Taux TVA livraison')/1000000,'Livraison TEMU · '+key,'gross');
   base+=b;taxTotal+=t+st;shipping+=s-st;
  });
  if(used.size!==data.orderList.length)throw Error('TEMU · Toutes les lignes de prix doivent être rapprochées');
  expected=money(parent.estimatedRevenue,'Revenu vendeur');
  if(!equal(base,money(parent.basePriceTotal,'Total produits'))||!equal(shipping,money(parent.shippingAmountTotal,'Total livraison'))||!equal(taxTotal,money(parent.taxTotal,'Total TVA')))commercialObservations.push({code:'source_component_total_difference',blocking:false});
  // TEMU's line taxes precede platform discounts. The parent provides the final
  // tax total. Allocate that actual source total in cents, conserving the sum.
  const after=parent.taxTotalAfterDiscount?money(parent.taxTotalAfterDiscount,'TVA après remise'):taxTotal;
  if(parent.estimatedRevenueDeduction&&money(parent.estimatedRevenueDeduction,'Retenue vendeur'))commercialObservations.push({code:'source_seller_deduction',amount:money(parent.estimatedRevenueDeduction,'Retenue vendeur'),blocking:false});
  if(after!==taxTotal&&!taxTotal)commercialObservations.push({code:'source_tax_allocation_unavailable',received:after,calculated:taxTotal,blocking:false});
  if(after!==taxTotal&&taxTotal){
   const parts=entries.map((e,i)=>{const exact=cents(after)*e.tax/taxTotal;return {i,value:Math.floor(exact),fraction:exact-Math.floor(exact)};});
   let rest=cents(after)-parts.reduce((s,p)=>s+p.value,0);for(const p of [...parts].sort((a,b)=>b.fraction-a.fraction)){if(rest-->0)p.value++;}
   for(const p of parts){const e=entries[p.i];e.grossCalculation={unit:e.gross,quantity:1,discounts:[e.tax],additions:[p.value/100]};e.grossDecimal=decimalTotal(e.grossCalculation.unit,1,e.grossCalculation.discounts,e.grossCalculation.additions);e.gross=e.gross-e.tax+p.value/100;e.tax=p.value/100;e.item.price=(e.gross-e.tax)/e.item.quantity;}
  }
 }else if(order.channel==='shopify'){
  if(typeof src.taxes_included!=='boolean')throw Error('Shopify · Détail prix et TVA à actualiser par API');
  function row(raw,product,label,total,grossCalculation={unit:total,quantity:1,discounts:[],additions:[]}){
   if(!Array.isArray(raw.tax_lines))throw Error('Shopify · TVA source absente : '+label);
   const taxes=raw.tax_lines.map(t=>({price:amount(t?.price,'TVA Shopify'),rate:amount(t?.rate,'Taux TVA Shopify')*100}));
   if(taxes.some(t=>t.rate===0&&t.price!==0))throw Error('Shopify · Montant de TVA sans taux applicable : '+label);
   // Shopify supplies the applied rate separately from the amount after
   // discounts. Rounding a small tax to zero does not make its rate zero.
   const applied=taxes.filter(t=>t.rate!==0),tax=taxes.reduce((s,t)=>s+t.price,0);
   if(applied.length>1)throw Error('Shopify · Taxes multiples à configurer : '+label);
   if(applied.length&&(src.tax_exempt===true||raw.taxable===false))throw Error('Shopify · Taux TVA et exonération source contradictoires : '+label);
   add(product,total+(src.taxes_included?0:tax),tax,applied[0]?.rate||0,label,src.taxes_included?'gross':'net',src.taxes_included?grossCalculation:{...grossCalculation,additions:[...grossCalculation.additions,...taxes.map(t=>t.price)]});
  }
  lines.forEach((l,i)=>{const r=l.source_payload||{};if(!Array.isArray(r.discount_allocations))throw Error('Shopify · Remises à actualiser : '+l.source_sku);const total=amount(r.price,'Prix Shopify')*Number(l.quantity)-r.discount_allocations.reduce((s,d)=>s+amount(d.amount,'Remise Shopify'),0);row(r,products[i],l.source_sku,total,{unit:amount(r.price,'Prix Shopify'),quantity:Number(l.quantity),discounts:r.discount_allocations.map(d=>amount(d.amount,'Remise Shopify')),additions:[]});});
  if(!Array.isArray(src.shipping_lines))throw Error('Shopify · Frais de livraison à actualiser');
  for(const s of src.shipping_lines){const value=amount(s.discounted_price,'Prix livraison Shopify');if(value||s.tax_lines?.some(t=>Number(t.price)))row(s,null,'Livraison Shopify',value);}
  expected=amount(src.total_price,'Total Shopify');
 }else if(order.channel==='amazon'){
  // A cancelled/reimported one-line equivalent retains the original Amazon totals.
  const originalLines=order.erp_live?.equivalentOriginalLines||order.erp_live?.previousCancelledCycle?.equivalentOriginalLines;
  const pricingRows=lines.map(l=>l.source_payload?.origin==='erplain_live_equivalent'&&lines.length===1&&originalLines?.length===1?originalLines[0].source_payload:l.source_payload||{});
  const taxContext={currency,eurExchangeRate,preferExactRate,total:pricingRows.reduce((sum,r)=>sum+amount(r.itemprice,'Prix Amazon')+amount(r.shippingprice,'Livraison Amazon'),0)};
  const receivedTax=(gross,tax,product)=>{
   try{return {tax,rate:rateFromTax(gross-tax,tax,codes,order.address?.country,taxContext),codes:null};}
   catch(error){
    // Incoherent source tax does not override the product's configured ERP
    // rate. Only an explicit, uniquely identified catalogue rate is usable.
    const selected=Array.isArray(product?.tax_codes)?product.tax_codes:null;
    const configured=selected?.length===0?{rate:0,codes:[]}:selected?.length===1?codes.filter(c=>String(c.id)===String(selected[0].id)&&c.active!==false&&c.tax_rates?.length===1):null;
    let rate,preferred;
    if(configured?.rate===0){rate=0;preferred=[];}
    else if(Array.isArray(configured)&&configured.length===1){rate=Number(configured[0].tax_rates[0].rate);preferred=[{id:String(configured[0].id)}];}
    if(!Number.isFinite(rate)||rate<0)throw error;
    const calculated=cents(gross-gross/(1+rate/100))/100;
    commercialObservations.push({code:'source_tax_difference_supplier_rate',received:tax,calculated,rate,blocking:false});
    return {tax:calculated,rate,codes:preferred};
   }
  };
  lines.forEach((l,i)=>{const r=l.source_payload?.origin==='erplain_live_equivalent'&&lines.length===1&&originalLines?.length===1?originalLines[0].source_payload:(l.source_payload||{}),gross=amount(r?.itemprice,'Prix Amazon · '+l.source_sku),tax=amount(r?.itemtax,'TVA Amazon · '+l.source_sku);
   if(optional(r.itempromotiondiscount,'Remise Amazon')||optional(r.shippromotiondiscount,'Remise livraison Amazon'))commercialObservations.push({code:'source_discount_supplier_rules',sku:l.source_sku,itemDiscount:optional(r.itempromotiondiscount,'Remise Amazon'),shippingDiscount:optional(r.shippromotiondiscount,'Remise livraison Amazon'),blocking:false});
   const itemTax=receivedTax(gross,tax,products[i]);add(products[i],gross,itemTax.tax,itemTax.rate,l.source_sku,'gross',{unit:gross,quantity:1,discounts:[],additions:[]},itemTax.codes);
   const ship=amount(r.shippingprice,'Prix livraison Amazon'),st=amount(r.shippingtax,'TVA livraison Amazon');if(ship||st){
    let rate;try{rate=rateFromTax(ship-st,st,codes,order.address?.country,taxContext);}catch(error){
     if(ship<st)throw error;const price=ship-st;
     entries.push({item:{type:'shipping_cost',description:'Livraison Amazon · '+l.source_sku,quantity:1,price,apply_discount_rules:true},gross:price,tax:0,taxUnspecified:true,rate:null,basis:'net',grossDecimal:decimalTotal(price,1),grossCalculation:{unit:price,quantity:1,discounts:[],additions:[]}});
     commercialObservations.push({code:'source_shipping_tax_unspecified',received:st,receivedGross:ship,blocking:false});
    }
    if(rate!==undefined)add(null,ship,st,rate,'Livraison Amazon · '+l.source_sku,'gross');
   }
  });
 }else if(['tender','samples'].includes(order.channel)){
  lines.forEach((l,i)=>{const r=l.source_payload||{},unit=r.puht??r.prixunitaireht??r.prix;
   const net=present(unit)?amount(unit,'Prix HT · '+l.source_sku)*Number(l.quantity):amount(r.totalht,'Total HT · '+l.source_sku);
   const sourceDiscount=optional(r.rem,'Remise ligne')||optional(r.remiseglobale,'Remise globale');if(sourceDiscount)commercialObservations.push({code:'source_discount_supplier_rules',sku:l.source_sku,received:sourceDiscount,blocking:false});
   const rate=amount(r.taxes,'Taux TVA · '+l.source_sku),tax=cents(net*rate/100)/100;
   add(products[i],cents(net)/100+tax,tax,rate,l.source_sku);
   // Tender prices retain Excel precision; Erplain computes totals and taxes.
   if(order.channel==='tender')entries.at(-1).item.price=present(unit)&&Number(products[i].quantity)===Number(l.quantity)?amount(unit,'Prix HT · '+l.source_sku):net/Number(products[i].quantity);
  });
  const shippingCost=optional(src.coutsdexpedition,'Frais de livraison');
  if(shippingCost){
   // The received charge is transmitted, never dropped. No source tax rate
   // is guessed: omit the optional codes and let ERPLAIN apply its defaults.
   const item={type:'shipping_cost',description:'Livraison source',quantity:1,price:shippingCost,apply_discount_rules:true};
   entries.push({item,gross:shippingCost,tax:0,taxUnspecified:true,rate:null,basis:'net',grossDecimal:decimalTotal(shippingCost,1),grossCalculation:{unit:shippingCost,quantity:1,discounts:[],additions:[]}});
   commercialObservations.push({code:'source_shipping_tax_unspecified',received:shippingCost,blocking:false});
  }
  // Excel's "Total" is a line total, not the order total copied on its first row.
  if(lines.every(l=>present(l.source_payload?.total)))expected=lines.reduce((s,l)=>s+amount(l.source_payload.total,'Total ligne'),0);
 }else throw Error('BC · Source des prix non configurée : '+order.channel);
 const total=cents(entries.reduce((s,e)=>s+e.gross,0))/100,tax=cents(entries.reduce((s,e)=>s+e.tax,0))/100;
 if(commercialObservations.some(x=>x.code==='source_discount_supplier_rules'))for(const entry of entries)entry.item.apply_discount_rules=true;
 const sourceTotalObservation=expected===undefined?null:{received:expected,calculated:total,difference:total-expected,blocking:false};
 return {version:2,currency,eurExchangeRate,sourceTotalObservation,commercialObservations,taxSourceComplete:!entries.some(e=>e.taxUnspecified),tax_type:'exclusive',total:expected??total,sourceLinesTotal:total,tax,commercialBasis:order.channel==='temu'?temuCommercialSource(order,temuCountryAmounts(order))?.v3CommercialBasis:undefined,taxPolicy:order.channel==='temu'?temuDestinationVat(order).policy:'source',items:entries.map(e=>e.item),lineAmounts:entries.map(e=>({type:e.item.type||'normal',variantId:String(e.item.variant?.id||''),quantity:Number(e.item.quantity),taxCodes:(e.item.tax_codes||[]).map(t=>String(t.id)).sort(),taxUnspecified:e.taxUnspecified===true,unitPrice:e.item.price,gross:e.gross,grossDecimal:e.grossDecimal,grossCalculation:e.grossCalculation,tax:e.tax,rate:e.rate,basis:e.basis})),source:order.channel};
}
// User-authorized OR policy: strictly below EUR 0.50 or 5% of order total.
// Currency rates retain Erplain's quote: foreign units per default EUR.
export function acceptedBcTotal(actual,pricing){
 if(!decimalNumber(actual?.total)||!decimalNumber(pricing?.total))return false;
 if(actual.currency?.label&&actual.currency.label!==pricing.currency)return false;
 return acceptedMonetaryDifference(actual.total,pricing.total,pricing);
}
function linePrice(value){
 if(!decimalNumber(value))throw Error('BC · Prix de ligne Erplain absent ou invalide');
 return Number(value);
}
// Keep source decimal arithmetic exact in the trace only. The existing items
// sent to Erplain are unchanged. All denominators here are powers of ten.
function decimalParts(value){
 const n=linePrice(value);if(n===0)return [0n,1n];
 const m=String(value).trim().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i),fraction=m[2]||'',digits=BigInt(m[1]+fraction),shift=Number(m[3]||0)-fraction.length;
 return shift>=0?[digits*10n**BigInt(shift),1n]:[digits,10n**BigInt(-shift)];
}
function decimalTotal(unit,quantity,discounts=[],additions=[]){
 const [u,ud]=decimalParts(unit),[q,qd]=decimalParts(quantity);let n=u*q,d=ud*qd;
 for(const [values,sign] of [[discounts,-1n],[additions,1n]])for(const value of values){const [v,vd]=decimalParts(value);n=n*vd+sign*v*d;d*=vd;}
 if(n<0n)throw Error('BC · Montant décimal source négatif');
 const places=d.toString().length-1,digits=n.toString().padStart(places+1,'0');
 return places?digits.slice(0,-places)+'.'+digits.slice(-places):digits;
}
function grossPriceTicks(gross,quantity,rate,taxType){
 const [g,gd]=decimalParts(gross),[q,qd]=decimalParts(quantity),[r,rd]=decimalParts(rate);
 if(q===0n)throw Error('BC · Quantité du prix source invalide');
 let numerator=g*qd,denominator=gd*q;
 if(taxType==='exclusive'){numerator*=100n*rd;denominator*=100n*rd+r;}
 const scaled=numerator*10000n,ticks=scaled/denominator+(scaled%denominator*2n>=denominator?1n:0n);
 if(ticks>999999999999n)throw Error('BC · Prix de ligne hors précision Erplain');
 return ticks.toString();
}
// Erplain stores decimal(12,4). Quantize the submitted decimal representation,
// not a binary float multiplied by 10000. Never round a supplier response into
// conformity: unexpected extra precision must remain visible.
function priceTicks(value,exact=false){
 const n=linePrice(value),match=String(value).trim().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
 const fraction=match[2]||'',digits=BigInt(match[1]+fraction),shift=4+Number(match[3]||0)-fraction.length;
 if(n===0){if(exact&&digits!==0n)throw Error('BC · Précision du prix Erplain non conforme');return '0';}
 let ticks;
 if(shift>=0)ticks=digits*10n**BigInt(shift);
 else{const divisor=10n**BigInt(-shift),rest=digits%divisor;
  if(exact&&rest!==0n)throw Error('BC · Précision du prix Erplain non conforme');
  ticks=digits/divisor+(rest*2n>=divisor?1n:0n);
 }
 if(ticks>999999999999n)throw Error('BC · Prix de ligne hors précision Erplain');
 return ticks.toString();
}
export function verifyBcPricing(actual,pricing){
 if(!actual||actual.total==null||!Array.isArray(actual.line_items)||actual.line_items.some(l=>l.tax_amount==null))throw Error('BC · Contrôle des montants Erplain incomplet');
 actual.line_items.forEach(l=>linePrice(l?.price));
 if(!acceptedBcTotal(actual,pricing))throw Error('BC · Total Erplain '+Number(actual.total).toFixed(2)+' différent du total source '+Number(pricing.total).toFixed(2));
 verifySourceCommercialTotals(actual,pricing);
 if(Array.isArray(pricing.items)){
  // A legacy zero freight row is preserved in Erplain. Sources omit freight
  // when it has no amount; only explicitly proved neutral rows may be ignored
  // for comparison, never deleted or rewritten in the document.
  const zero=(l,k,nullable=false)=>Object.hasOwn(l,k)&&(nullable&&l[k]===null||decimalNumber(l[k])&&Number(l[k])===0);
  const neutral=l=>l.type==='shipping_cost'&&decimalNumber(l.quantity)&&Number(l.quantity)===1&&zero(l,'price')&&zero(l,'tax_amount')&&['ecotax','discount','discount_rule_amount'].every(k=>zero(l,k,true))&&Array.isArray(l.tax_codes)&&l.tax_codes.every(t=>present(t?.id));
  const compared=pricing.items.some(l=>l.type==='shipping_cost')?actual.line_items:actual.line_items.filter(l=>!neutral(l));
  verifyBcLineIdentity(compared,pricing.items);
  if(!['inclusive','exclusive'].includes(actual.tax_type)||actual.tax_type!==pricing.tax_type)throw Error('BC · Base fiscale des prix Erplain différente ou absente');
  const adjustment=(l,k,source)=>{
   // Source creation omits inactive adjustments. Supplier responses must prove
   // the requested fields were received; null explicitly means no adjustment.
   if(!Object.hasOwn(l,k)){if(source)return 0;throw Error('BC · Contrôle des remises et écotaxes Erplain incomplet');}
   const v=l[k];if(v===null)return 0;
   if(!decimalNumber(v))throw Error('BC · Remise ou écotaxe de ligne absente ou invalide');
   return Number(v);
  };
  const identity=l=>[l.type||'normal',String(l.variant?.id||''),Number(l.quantity),l.tax_codes.map(t=>String(t.id)).sort()];
  const key=(l,source)=>JSON.stringify([...identity(l),...['discount','discount_rule_amount','ecotax'].map(k=>adjustment(l,k,source))]);
  const traced=Object.hasOwn(pricing,'lineAmounts');
  if(traced&&(!decimalNumber(pricing.sourceLinesTotal)||!Array.isArray(pricing.lineAmounts)||pricing.lineAmounts.length!==pricing.items.length))throw Error('BC · Montants des lignes source incomplets');
  const candidates=pricing.items.map((l,i)=>{
   const options=new Set([priceTicks(l.price)]);
   if(traced){const e=pricing.lineAmounts[i];
    if(!e||JSON.stringify([e.type,e.variantId,e.quantity,e.taxCodes])!==JSON.stringify(identity(l))||linePrice(e.unitPrice)!==linePrice(l.price)||!['net','gross'].includes(e.basis)||['gross','tax','rate'].some(k=>typeof e[k]!=='number'||!Number.isFinite(e[k])||e[k]<0)||e.tax>e.gross)throw Error('BC · Montants des lignes source incohérents');
    if(e.basis==='gross'&&Math.abs((e.gross-(pricing.tax_type==='exclusive'?e.tax:0))/e.quantity-e.unitPrice)>Number.EPSILON*Math.max(1,e.unitPrice)*8)throw Error('BC · Prix source non relié à ses montants');
    if(Object.hasOwn(e,'grossDecimal')||Object.hasOwn(e,'grossCalculation')){
     const c=e.grossCalculation,valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
     if(!c||!valid(c.unit)||!valid(c.quantity)||!Array.isArray(c.discounts)||!Array.isArray(c.additions)||![...c.discounts,...c.additions].every(valid)||c.unit*c.quantity-c.discounts.reduce((s,v)=>s+v,0)+c.additions.reduce((s,v)=>s+v,0)!==e.gross||e.grossDecimal!==decimalTotal(c.unit,c.quantity,c.discounts,c.additions))throw Error('BC · Montant décimal source non relié à sa ligne');
    }
    // Gross-authoritative sources can describe historical unit prices through
    // TTC / quantity / rate. Preserve the source tax separately; this price
    // check never overrides the tax-code or source-tax guards.
    if(e.basis==='gross')options.add(grossPriceTicks(e.grossDecimal??e.gross,e.quantity,e.rate,pricing.tax_type));
   }
   return {key:key(l,true),options};
  });
  if(traced&&(cents(pricing.lineAmounts.reduce((s,e)=>s+e.gross,0))!==cents(Number(pricing.sourceLinesTotal))||cents(pricing.lineAmounts.reduce((s,e)=>s+e.tax,0))!==cents(Number(pricing.tax))))throw Error('BC · Somme des lignes source incohérente');
  const received=compared.map(l=>({key:key(l,false),price:priceTicks(l.price,true)}));
  // Duplicate products and freight rows can have overlapping price choices.
  // A complete one-to-one matching avoids input-order dependent false refusals.
  const matched=new Array(candidates.length).fill(-1);
  const assign=(i,visited)=>{for(let j=0;j<candidates.length;j++){
   if(visited.has(j)||candidates[j].key!==received[i].key||!candidates[j].options.has(received[i].price))continue;
   visited.add(j);if(matched[j]===-1||assign(matched[j],visited)){matched[j]=i;return true;}
  }return false;};
  if(received.some((_,i)=>!assign(i,new Set())))throw Error('BC · Prix, remises ou écotaxes des lignes Erplain différents de la source');
 }
 const tax=actual.line_items.reduce((s,l)=>s+Number(l.tax_amount),0);
 // Accepted Erplain totals and taxes are retained; original source stays traceable.
 if(!Number.isFinite(tax)||tax<0||tax>Number(actual.total)||!acceptedMonetaryDifference(tax,pricing.tax,pricing))throw Error('BC · TVA Erplain '+tax.toFixed(2)+' différente de la TVA source '+pricing.tax.toFixed(2));
 return {total:Number(actual.total),tax:cents(tax)/100,sourceTotal:Number(pricing.total),sourceTax:Number(pricing.tax),authority:'erplain',tolerancePolicy:'lt-0.50-eur-or-lt-5-percent-order-total'};
}

// Distinguish an incomplete API response from a real product/quantity mismatch
// and from a tax-code mismatch. None of these checks may silently be skipped.
export function verifyBcLineIdentity(actual,expected){
 const rows=(items,origin)=>{
  if(!Array.isArray(items)||!items.length)throw Error('BC · Contrôle des lignes '+origin+' incomplet');
  return items.map(l=>{
   const type=l?.type||'normal',quantity=Number(l?.quantity);
   if(!l||!decimalNumber(l.quantity)||quantity<=0||!['normal','shipping_cost'].includes(type)||type==='normal'&&!present(l.variant?.id))throw Error('BC · Contrôle des lignes '+origin+' incomplet : produit ou quantité non reçu');
   if(!Array.isArray(l.tax_codes)||l.tax_codes.some(t=>!present(t?.id)))throw Error('BC · Contrôle TVA '+origin+' incomplet : codes non reçus');
   return [type,String(l.variant?.id||''),quantity,l.tax_codes.map(t=>String(t.id)).sort()];
  });
 };
 const a=rows(actual,'Erplain'),e=rows(expected,'source');
 const signature=items=>JSON.stringify(items.map(x=>JSON.stringify(x)).sort());
 if(signature(a.map(x=>x.slice(0,3)))!==signature(e.map(x=>x.slice(0,3))))throw Error('BC · Produits ou quantités des lignes Erplain différents de la source');
 if(signature(a)!==signature(e))throw Error('BC · Codes TVA Erplain différents de la source ; produits et quantités identiques');
 return true;
}

export function verifySourceCommercialTotals(actual,source){
 if(!source||!decimalNumber(source.total)||!decimalNumber(source.tax)||Number(source.tax)>Number(source.total))throw Error('BC · Montants source à récupérer avant préparation');
 if(!actual||!decimalNumber(actual.total))throw Error('BC · Montant Erplain non reçu');
 if(!present(source.currency)||!present(actual.currency?.label)||source.currency!==actual.currency.label)throw Error('BC · Devise Erplain différente ou absente de la source');
 if(!acceptedBcTotal(actual,source))throw Error('BC · Total Erplain '+Number(actual?.total).toFixed(2)+' différent du total source '+Number(source.total).toFixed(2));
 if(!Array.isArray(actual.line_items)||!actual.line_items.length||actual.line_items.some(l=>!decimalNumber(l?.tax_amount)))throw Error('BC · TVA Erplain non reçue');
 const tax=actual.line_items.reduce((n,l)=>n+Number(l.tax_amount),0);if(!Number.isFinite(tax)||tax<0||tax>Number(actual.total)||!acceptedMonetaryDifference(tax,source.tax,source))throw Error('BC · TVA Erplain '+tax.toFixed(2)+' différente de la TVA source '+Number(source.tax).toFixed(2));
 return {total:Number(actual.total),tax:cents(tax)/100,sourceTotal:Number(source.total),sourceTax:Number(source.tax),authority:'erplain',tolerancePolicy:'lt-0.50-eur-or-lt-5-percent-order-total'};
}
export async function withSourceCommercialGuard(api,id,source,fn){
 const {Order:actual}=await api.request('query V3SourceBeforeMutation($id:ID!){Order(id:$id){id total currency{label} line_items{tax_amount}}}',{id:String(id)});
 if(String(actual?.id)!==String(id))throw Error('BC · Identité Erplain différente');
 verifySourceCommercialTotals(actual,source);return fn();
}

