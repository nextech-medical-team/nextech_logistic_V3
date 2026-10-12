import {randomUUID} from 'node:crypto';
import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
import {shopifyCancellationReason} from './shopify-cancellation-policy.mjs';
import {importPostalCode} from './import-postal-code.mjs';

// Headers have already been normalized by readTable.
export function parseShopifyRows(rows){
 const required=['name','lineitemsku','lineitemquantity'];
 if(required.some(h=>!Object.hasOwn(rows[0]||{},h)))throw Error('Colonnes Shopify requises : Name, Lineitem sku, Lineitem quantity');
 const groups=new Map(),errors=[];let reference='';
 for(const row of rows){
  if(row.name)reference=row.name;
  const ref=reference;
  if(!ref){errors.push({row:row.row,reference:null,message:'Référence commande absente'});continue;}
  if(!groups.has(ref))groups.set(ref,{id:randomUUID(),channel:'shopify',reference:ref,recipient:'',address:{},source_date:null,source_payload:{importSource:'shopify-file'},lines:[],rawRows:[]});
  const order=groups.get(ref);order.rawRows.push(row);
  // Shopify leaves order-level cells empty on subsequent product rows.
  for(const [k,v] of Object.entries(row))if(k!=='row'&&v!=='')order.source_payload[k]=v;
  try{
   if(!row.lineitemsku)throw Error('SKU absent');
   const quantity=Number(String(row.lineitemquantity).replace(',','.'));
   if(!Number.isSafeInteger(quantity)||quantity<=0)throw Error('Quantité entière positive requise');
   order.lines.push({id:randomUUID(),order_id:order.id,source_line:String(row.row),source_sku:row.lineitemsku,quantity,source_payload:row});
  }catch(e){order.visibilityHold=true;order.visibilityReason='Import ligne '+row.row+' : '+e.message;errors.push({row:row.row,reference:ref,message:e.message});}
 }
 for(const order of groups.values()){
  const r=order.source_payload;
  order.address={name:r.shippingname||'',street:[r.shippingaddress1||r.shippingstreet,r.shippingaddress2].filter(Boolean).join(', '),postal:importPostalCode(String(r.shippingzip||'').replace(/^'/,''),r.shippingcountry),city:r.shippingcity||'',country:r.shippingcountry||'',phone:r.shippingphone||r.phone||''};
  order.address.email=r.email||'';
  order.recipient=order.address.name;order.source_date=r.createdat||r.paidat||null;
  r.name=order.reference;
  r.created_at=order.source_date;
  if(r.financialstatus)r.financial_status=r.financialstatus;
  if(r.fulfillmentstatus)r.fulfillment_status=r.fulfillmentstatus;
  r.shipping_lines=r.shippingmethod?[{title:r.shippingmethod}]:[];
  r.cancelled_at=r.cancelledat||null;
  if(shopifyCancellationReason(r))r.cancelled=true;
  r.importRows=order.rawRows;
  r.currency=r.currency||'';
  r.total_price=r.total||null;
  r.shipping_address={name:order.address.name,address1:r.shippingaddress1||r.shippingstreet||'',address2:r.shippingaddress2||'',zip:order.address.postal,city:order.address.city,country_code:order.address.country,phone:order.address.phone};
  r.line_items=order.lines.map(l=>({id:'file:'+l.source_line,sku:l.source_sku,quantity:l.quantity,name:l.source_payload.lineitemname||'',price:l.source_payload.lineitemprice||null}));
  r.importNeedsApiDetails=true;
  if(!order.visibilityHold&&/^\d+$/.test(r.id||'')){
   const normalized=normalizeShopifyOrders([r])[0];
   Object.assign(order,normalized);
  }

  if(order.visibilityHold){order.lines=[];r.visibilityRows=order.rawRows;}
  delete order.rawRows;
 }
 return {rows:rows.length,valid:[...groups.values()],errors};
}

// The CSV export has no Shopify line IDs or complete tax/discount/relay details.
// Enrich from the API when configured; file-only imports retain incomplete pricing.
export async function completeShopifyFileOrders(parsed,reader){
 for(const order of parsed.valid){
  if(order.visibilityHold)continue;
  const r=order.source_payload;
  try{
   if(!/^\d+$/.test(r.id||''))throw Error('Shopify · Colonne Id absente ou invalide');
   let api;
   try{api=typeof reader==='function'?await reader():reader;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!api){r.importApiUnavailable=true;continue;}
   const payload=await api.order(String(r.id));
   if(String(payload.id)!==String(r.id)||payload.name!==order.reference)throw Error('Shopify · Identité de commande différente du fichier');
   if(r.currency&&payload.currency!==r.currency)throw Error('Shopify · Devise différente du fichier');
   const signature=lines=>JSON.stringify(lines.map(l=>[String(l.sku||''),Number(l.quantity)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
   if(!Array.isArray(payload.line_items)||signature(payload.line_items)!==signature(order.lines.map(l=>({sku:l.source_sku,quantity:l.quantity}))))throw Error('Shopify · Articles ou quantités modifiés depuis l’export : exporter de nouveau la commande');
   const normalized=normalizeShopifyOrders([payload])[0];
   normalized.source_payload={...normalized.source_payload,importSource:'shopify-file',importRows:r.importRows,sourceShop:api.shop,importApiVerifiedAt:new Date().toISOString()};
   Object.assign(order,normalized);
  }catch(e){
   const message=e.code==='ENOENT'?'Shopify · Configuration de connexion API absente':e.message;
   order.visibilityHold=true;order.visibilityReason=message;order.lines=[];
   order.source_payload={...r,visibilityHold:true,visibilityReason:message,visibilityRows:r.importRows};
   parsed.errors.push({row:r.importRows?.[0]?.row,reference:order.reference,message});
  }
 }
}
