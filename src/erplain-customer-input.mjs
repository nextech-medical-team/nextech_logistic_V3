import {erplainCustomerLabel} from './customer-identity.mjs';
import {invoiceCustomerType} from './invoice-customer-policy.mjs';
import {bcAddresses} from './bc-authorization.mjs';

const clean=v=>String(v??'').trim();
const key=v=>clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function erplainCustomerInput(o){
 const input={label:erplainCustomerLabel(o),customer_type:invoiceCustomerType({orderId:o.id,channel:o.channel,sourcePayload:o.source_payload}),notes:'Compte V3. Aucun email envoyé.'};
 if(o.channel!=='temu')return {...input,customer_number:'V3:'+o.id};
 const number=clean(o.erp_live?.customerNumber);
 if(!number||number.startsWith('V3:'))throw Error('Client TEMU : numéro Erplain à générer');
 const a=o.address||{},row=Object.fromEntries(Object.entries(o.selectedSourceLines?.[0]?.source_payload?.excel||{}).map(([k,v])=>[key(k),clean(v)]));
 const get=(...names)=>names.map(n=>row[key(n)]).find(Boolean)||'';
 let first=get('prénom du destinataire','Recipient first name'),last=get('nom de famille du destinataire','Recipient last name');
 if(!first&&!last){const parts=clean(o.recipient||a.name).split(/\s+/);first=parts.shift()||'';last=parts.join(' ');}
 const address=bcAddresses({...a,name:a.name||o.recipient}).shipping_address;
 if(!address)throw Error('Client TEMU : adresse complète requise');
 return {...input,customer_number:number,first_name:first,last_name:last,...(clean(a.email)?{email:clean(a.email)}:{}),...(clean(a.phone)?{phone:clean(a.phone)}:{}),
  addresses:{data:['billing','shipping'].map(type=>({...address,type,default:true,...(clean(a.phone)?{phone:clean(a.phone)}:{})}))}};
}
export async function ensureErplainCustomerNumber(api,o,save){
 if(o.channel!=='temu'||o.erp_live?.customerNumber)return;
 const result=await api.request('mutation V3CustomerNumber {GenerateCustomerNumber}');
 const value=result?.GenerateCustomerNumber;
 if(!['string','number'].includes(typeof value)||!clean(value)||clean(value).startsWith('V3:'))throw Error('Client TEMU : numéro Erplain non reçu');
 o.erp_live.customerNumber=clean(value);await save(o);
}
