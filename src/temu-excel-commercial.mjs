import {excelOriginalLines} from './temu-excel-identity.mjs';
import {createHash} from 'node:crypto';
const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const cents=v=>Math.round(v*100);
function columns(line){return Object.fromEntries(Object.entries(line.source_payload?.excel||{}).map(([k,v])=>[norm(k),v]));}
export function excelMoney(raw,label,{optional=false,country}={}){
 if(raw==null||String(raw).trim()===''){if(optional)return {amount:0,currency:null};throw Error('Excel : montant absent — '+label);}
 const s=String(raw).trim().replace(/[\s\u00a0\u202f]/g,'');
 const match=s.match(/^(?:(EUR|USD|GBP|PLN|CZK|SEK|DKK|HUF|RON|BGN|NOK|CHF|€|£|zł|kr\.?|Kč|Ft|lei))?(\d+(?:[.,]\d{1,2})?)(EUR|USD|GBP|PLN|CZK|SEK|DKK|HUF|RON|BGN|NOK|CHF|€|£|zł|kr\.?|Kč|Ft|lei)?$/i);
 if(!match||match[1]&&match[3])throw Error('Excel : montant invalide — '+label);
 const symbol=(match[1]||match[3])?.toLowerCase();
 const currency=/^kr\.?$/.test(symbol||'')?({DK:'DKK',SE:'SEK',NO:'NOK'}[country]):symbol?({'€':'EUR','£':'GBP','zł':'PLN','kč':'CZK',ft:'HUF',lei:'RON'}[symbol]||symbol.toUpperCase()):null;
 if(symbol&&!currency)throw Error('Excel : devise kr ambiguë — pays requis');
 return {amount:Number(match[2].replace(',','.')),currency};
}
export function excelAmounts(lines,{country}={}){
 let currency=null;const rows=lines.map(l=>{
  const r=columns(l);const money=(name,optional=false)=>{const m=excelMoney(r[norm(name)],name,{optional,country});if(m.currency){if(currency&&currency!==m.currency)throw Error('Excel : devises différentes');currency=m.currency;}return m.amount;};
  const net=money('Total du prix de base après réduction'),tax=money('Taxe sur les produits'),shipping=money("Total de l'expédition (hors taxes)"),shippingTax=money("Taxe d'expédition");
  const sellerDiscount=money('Réduction de la part du vendeur',true),temuDiscount=money('Réduction de la part de Temu',true),refund=money('Remboursement des produits',true);
  if(refund)throw Error('Excel : remboursement à rapprocher avant création');
  // Seller base is a line total after discounts, already including quantity.
  // Retail prices and buyer payment must never substitute for seller proceeds.
  return {net,tax,shipping,shippingTax,sellerDiscount,temuDiscount};
 });
 if(!currency)throw Error('Excel : devise absente');
 const sum=k=>rows.reduce((n,r)=>n+cents(r[k]),0)/100;
 return {currency,rows,net:cents(sum('net')+sum('shipping'))/100,tax:cents(sum('tax')+sum('shippingTax'))/100,total:cents(sum('net')+sum('shipping')+sum('tax')+sum('shippingTax'))/100,discount:cents(sum('sellerDiscount')+sum('temuDiscount'))/100,shipping:sum('shipping')};
}

export const isTemuExcel=order=>order?.channel==='temu'&&order.source_payload?.origin==='temu_excel';
export function excelCommercialSource(order,lines){
 if(!lines.length||lines.some(l=>!Number.isSafeInteger(Number(l.quantity))||Number(l.quantity)<=0))throw Error('Excel : articles ou quantités invalides');
 const amounts=excelAmounts(lines,{country:order.address?.country});
 const companies=lines.map(l=>{const row=columns(l);return String(['nom de société','nom de l’entreprise','company name','business name'].map(k=>row[norm(k)]).find(v=>String(v??'').trim())||'').trim();});
 if(new Set(companies).size!==1)throw Error('Excel : sociétés contradictoires');
 const identity=lines.map(l=>[String(l.source_line),l.source_sku,Number(l.quantity),l.source_payload?.excel]).sort((a,b)=>a[0].localeCompare(b[0]));
 return {...amounts,company:companies[0],fingerprint:createHash('sha256').update(JSON.stringify([order.reference,order.address?.country,identity])).digest('hex'),source:'temu_excel'};
}
export function verifiedExcelCommercial(order,lines){
 const saved=order.source_payload?.temuExcelCommercial;
 if(!saved?.fingerprint||saved.source!=='temu_excel'||!Number.isFinite(saved.total)||!Number.isFinite(saved.tax)||!/^[A-Z]{3}$/.test(saved.currency||''))throw Error('Excel : validation commerciale requise avant préparation');
 // The fingerprint contains the complete original Excel rows. Equal source
 // fingerprints cannot become a source edit merely because the parser changed.
 // Use current source arithmetic, never the historical calculated cache.
 if(lines){const current=excelCommercialSource(order,excelOriginalLines(order,lines));if(current.fingerprint!==saved.fingerprint||current.currency!==saved.currency)throw Error('Excel : prix ou articles modifiés depuis la validation');return current;}
 return saved;
}
