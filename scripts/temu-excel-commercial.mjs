import {createHash} from 'node:crypto';
import {buildBcPricing} from '../src/bc-pricing.mjs';
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
  const net=money('Total du prix de vente après réductions (hors taxes)'),tax=money('Taxe sur les produits'),shipping=money("Total de l'expédition (hors taxes)"),shippingTax=money("Taxe d'expédition"),beforeDiscount=money('Prix de vente (hors taxes)');
  const sellerDiscount=money('Réduction de la part du vendeur',true),temuDiscount=money('Réduction de la part de Temu',true),refund=money('Remboursement des produits',true);
  if(refund)throw Error('Excel : remboursement à rapprocher avant création');
  // TEMU exports this field as a line total, already including the quantity.
  if(Math.abs(cents(beforeDiscount-sellerDiscount-temuDiscount)-cents(net))>1)throw Error('Excel : total de ligne avant réductions, réductions et total net incohérents — '+l.source_sku);
  return {net,tax,shipping,shippingTax,sellerDiscount,temuDiscount};
 });
 if(!currency)throw Error('Excel : devise absente');
 const sum=k=>rows.reduce((n,r)=>n+cents(r[k]),0)/100;
 return {currency,rows,net:cents(sum('net')+sum('shipping'))/100,tax:cents(sum('tax')+sum('shippingTax'))/100,total:cents(sum('net')+sum('shipping')+sum('tax')+sum('shippingTax'))/100,discount:cents(sum('sellerDiscount')+sum('temuDiscount'))/100,shipping:sum('shipping')};
}
export function excelPricing(order,lines,products,codes){
 const amounts=excelAmounts(lines,{country:order.address?.country});
 // Reuse Amazon's source-total, tax-rate and converted-quantity calculation.
 const source=lines.map((l,i)=>{const r=amounts.rows[i];return {...l,source_payload:{itemprice:cents(r.net+r.tax)/100,itemtax:r.tax,shippingprice:cents(r.shipping+r.shippingTax)/100,shippingtax:r.shippingTax}};});
 const pricing=buildBcPricing({...order,channel:'amazon',source_payload:{currency:amounts.currency}},source,products,codes);
 // Preserve source gross cents; inclusive pricing avoids losing a cent when
 // TEMU independently rounds net and tax columns.
 pricing.tax_type='inclusive';
 pricing.items=pricing.items.map((item,i)=>({...item,...(item.type==='shipping_cost'?{description:item.description.replace('Livraison Amazon','Livraison TEMU')} : {}),price:pricing.lineAmounts[i].gross/Number(item.quantity)}));
 pricing.lineAmounts=pricing.lineAmounts.map((item,i)=>({...item,unitPrice:pricing.items[i].price,basis:'gross'}));
 return {...pricing,source:'temu_excel',excel:amounts};
}
export function customerDetails(order,lines){
 const rows=lines.map(columns),first=rows[0]||{};const get=(...names)=>names.map(n=>first[norm(n)]).find(v=>String(v??'').trim())||'';
 const company=String(get('nom de société','nom de l’entreprise','company name','business name')).trim();
 for(const row of rows){const other=String(row[norm('nom de société')]||row[norm('nom de l’entreprise')]||row[norm('company name')]||row[norm('business name')]||'').trim();if(other!==company)throw Error('Excel : sociétés contradictoires');}
 const a=order.address,firstName=String(get('prénom du destinataire','Recipient first name')).trim(),lastName=String(get('nom de famille du destinataire','Recipient last name')).trim();
 const label=company||order.recipient;
 const customer_type=company?'company':'individual';
 const address={label:order.recipient,address_1:a.street,city:a.city,postal_code:a.postal,country:a.country,type:'billing_shipping',default:true,...(a.phone?{phone:a.phone}:{})};
 const identity=[customer_type,norm(label),norm(a.street),norm(a.postal),norm(a.city),a.country];
 const customer_number='TEMU-CLIENT-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);
 return {identity,input:{label,customer_type,...(!company?{first_name:firstName||order.recipient,last_name:lastName}:{}),customer_number,...(a.email?{email:a.email}:{}),...(a.phone?{phone:a.phone}:{}),addresses:{data:[address]},notes:'Import Excel TEMU local — société Erplain TEST uniquement.'}};
}
export function matchesCustomer(candidate,details){
 if(candidate.customer_type!==details.input.customer_type||norm(candidate.label)!==norm(details.input.label))return false;
 const wanted=details.input.addresses.data[0];
 return (candidate.addresses?.data||[]).some(a=>['address_1','postal_code','city','country'].every(k=>norm(a[k])===norm(wanted[k])));
}
export const customerFields='id label customer_type customer_number first_name last_name addresses(first:100){data{id address_1 postal_code city country} paginatorInfo{hasMorePages}}';
export async function findCustomer(api,details){
 const {Customers:r}=await api.read(`query LocalFindCustomer($where:QueryCustomersWhereWhereConditions){Customers(first:100,where:$where){data{${customerFields}} paginatorInfo{hasMorePages}}}`,{where:{OR:[{column:'CUSTOMER_NUMBER',operator:'EQ',value:details.input.customer_number},{column:'LABEL',operator:'EQ',value:details.input.label}]}});
 if(!r||r.paginatorInfo?.hasMorePages)throw Error('Recherche client incomplète : rapprochement requis');
 if(r.data.some(c=>c.addresses?.paginatorInfo?.hasMorePages))throw Error('Adresses client incomplètes : rapprochement requis');
 const keyed=r.data.filter(c=>c.customer_number===details.input.customer_number);
 if(keyed.some(c=>!matchesCustomer(c,details)))throw Error('Client identifié mais coordonnées différentes : contrôle requis');
 const hits=r.data.filter(c=>matchesCustomer(c,details));if(hits.length>1)throw Error('Plusieurs clients correspondent : contrôle requis');return hits[0]||null;
}

export function temuInternalNotes(order,lines=[]){
 const raw=columns(lines[0]||{}),dateText=raw[norm('date d’achat')]||raw[norm('Purchase date')]||'';
 const offset=String(dateText).match(/\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)/i);
 const date=new Date(Date.parse(order.source_date)+(offset?(offset[1]==='+'?1:-1)*(Number(offset[2])*60+Number(offset[3]||0))*60000:0));
 const formatted=Number.isFinite(date.getTime())?date.toISOString().slice(0,10).split('-').reverse().join('/'):'Non renseignée';
 return 'Commande n°'+order.reference+' du '+formatted+' / Gestionnaire : TEMU '+String(order.address?.country||order.source_payload?.country||'').toUpperCase()+' / Contact : '+order.recipient+' / Téléphone : '+(order.address?.phone||'Non renseigné');
}
