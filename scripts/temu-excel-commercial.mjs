import {createHash} from 'node:crypto';
import {buildBcPricing} from '../src/bc-pricing.mjs';
const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function columns(line){return Object.fromEntries(Object.entries(line.source_payload?.excel||{}).map(([k,v])=>[norm(k),v]));}
export {excelMoney,excelAmounts} from '../src/temu-excel-commercial.mjs';
export function excelPricing(order,lines,products,codes){return buildBcPricing({...order,channel:'temu',source_payload:{...order.source_payload,origin:'temu_excel'}},lines,products,codes);}
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
