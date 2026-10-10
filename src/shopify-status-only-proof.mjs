import {createHash} from 'node:crypto';
const fail=message=>{throw Error('Shopify · '+message);};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const stable=value=>JSON.stringify(canonical(value));
function commercial(payload){
 if(!payload?.id||!Array.isArray(payload.line_items)||!payload.line_items.length||!payload.shipping_address||!payload.currency||payload.total_price==null||typeof payload.taxes_included!=='boolean')fail('données commerciales incomplètes');
 const seen=new Set();
 const lines=payload.line_items.map(l=>{
  const id=String(l.id||'');if(!id||seen.has(id)||!l.sku||!Number.isInteger(l.quantity)||l.quantity<=0||l.price==null||!Array.isArray(l.tax_lines)||!Array.isArray(l.discount_allocations))fail('lignes commerciales incomplètes');seen.add(id);
  return {id,sku:l.sku,quantity:l.quantity,price:String(l.price),tax_lines:l.tax_lines,discount_allocations:l.discount_allocations};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 if(!Array.isArray(payload.shipping_lines))fail('frais de livraison incomplets');
 return {id:String(payload.id),currency:payload.currency,total_price:String(payload.total_price),taxes_included:payload.taxes_included,shipping_address:payload.shipping_address,shipping_lines:payload.shipping_lines,lines};
}
// This proof authorizes no write on its own. The caller must also prove complete
// Erplain/V3 allocations, preserve labels, and revalidate immediately before apply.
export function unchangedPartialCommercial(order,payload){
 try{return order?.channel==='shopify'&&order.partial_mode===true&&stable(commercial(order.source_payload))===stable(commercial(payload));}catch{return false;}
}
export function proveShopifyStatusOnly({order,pending,live,livePayload,sourceRows,sourceSku,orderedErplain,remainingErplain}){
 if(order?.channel!=='shopify'||order.partial_mode!==true||!order.erp_live?.bc?.id)fail('commande partielle non rapprochée');
 const original=order.source_payload;
 if(!pending)fail('information source absente');
 const before=commercial(original),after=commercial(pending);
 if(stable(before)!==stable(after))fail('articles, montants ou adresse modifiés : rapprochement requis');
 if(!livePayload||stable(commercial(livePayload))!==stable(after))fail('données Shopify différentes depuis la réception');
 if(live.id!=='gid://shopify/Order/'+before.id||!live.updatedAt||!pending.updated_at||live.updatedAt!==pending.updated_at||live.pageInfo?.hasNextPage!==false||!Array.isArray(live.lines)||live.lines.length!==before.lines.length)fail('lecture Shopify incomplète ou plus récente : actualiser');
 const seen=new Set();
 for(const line of live.lines){
  const id=String(line.id||'').replace(/^gid:\/\/shopify\/LineItem\//,'');
  const source=before.lines.find(l=>l.id===id);
  if(!source||seen.has(id)||source.sku!==line.sku||source.quantity!==line.quantity||line.currentQuantity!==line.quantity)fail('quantités Shopify modifiées ou non vérifiables');
  seen.add(id);
 }
 const candidates=live.lines.filter(l=>l.sku===sourceSku);
 if(candidates.length!==1||!Number.isFinite(orderedErplain)||orderedErplain<=0||!Number.isFinite(remainingErplain)||remainingErplain<=0||remainingErplain>orderedErplain)fail('conversion source/Erplain ambiguë');
 const source=candidates[0],ratio=orderedErplain/source.quantity;
 const rows=sourceRows?.filter(l=>l.source_sku===sourceSku);
 if(!rows?.length||rows.length!==1)fail('correspondance source absente ou ambiguë');
 const row=rows[0],target=row.target_sku||row.mapped_sku;
 const targetQty=row.target_quantity!=null?Number(row.target_quantity):Number(row.quantity)*Number(row.mapping_target_qty)/Number(row.mapping_source_qty);
 if(String(row.source_line)!==source.id.replace(/^gid:\/\/shopify\/LineItem\//,'')||Number(row.quantity)!==source.quantity||target!==sourceSku||!Number.isFinite(targetQty)||targetQty!==orderedErplain)fail('conversion source/Erplain non prouvée');
 return {orderId:before.id,sourceSku,ratio,remainingErplain,sourceRemaining:source.quantity,version:live.updatedAt,fulfillmentStatus:pending.fulfillment_status,pendingFingerprint:createHash('sha256').update(stable(pending)).digest('hex')};
}
