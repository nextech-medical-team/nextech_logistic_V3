import {createHash} from 'node:crypto';
const fail=reason=>{throw Error('Remplacement du reliquat : '+reason);};
const qty=value=>{if(value==null||value===''||typeof value==='boolean'||!Number.isFinite(Number(value))||Number(value)<0)fail('quantité non vérifiable');return Number(value);};
const key=l=>{const variant=l.variant?.id??l.variantId,location=l.location?.id??l.locationId;if(!variant||!location)fail('produit ou emplacement absent');return String(variant)+':'+String(location);};
function quantities(lines){
 if(!Array.isArray(lines))fail('lignes de livraison absentes');
 const map=new Map();for(const l of lines){if(l.type==='shipping_cost')continue;if(l.type&&l.type!=='normal')fail('type de ligne non pris en charge');const k=key(l);map.set(k,(map.get(k)||0)+qty(l.quantity));}return map;
}
const same=(a,b)=>a.size===b.size&&[...a].every(([k,v])=>b.has(k)&&Math.abs(v-b.get(k))<1e-6);
export function shippingSignature(bc){
 const list=bc?.shipping_orders;if(!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false)fail('liste des BL incomplète');
 const seen=new Set();const normalized=list.data.map(bl=>{
  if(!bl.id||seen.has(String(bl.id)))fail('BL absent ou dupliqué');seen.add(String(bl.id));
  if(typeof bl.update_stock!=='boolean'||!bl.status)fail('statut du BL non vérifié');
  return {id:String(bl.id),label:bl.label,status:bl.status,update_stock:bl.update_stock,lines:[...quantities(bl.line_items)].sort(),lineIds:bl.line_items.map(l=>String(l.id)).sort()};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export function provePartialRemainder(order,bc,partials,request){
 if(order.partial_mode!==true||String(order.erp_live?.bc?.id)!==String(bc?.id))fail('commande et BC non rapprochés');
 if(bc.update_stock!==false)fail('politique de stock du BC historique à rapprocher');
 if(!Array.isArray(partials))fail('livraisons V3 absentes');
 const signature=shippingSignature(bc),allocated=new Map();
 for(const bl of bc.shipping_orders.data){
  if(bl.status==='cancelled')continue;
  if(!['ready_to_ship','shipped','delivered'].includes(bl.status))fail('un BL est encore en préparation');
  for(const [k,n] of quantities(bl.line_items))allocated.set(k,(allocated.get(k)||0)+n);
 }
 for(const delivery of partials){
  if(delivery.status==='cancelled'||delivery.bl?.status==='cancelled')continue;
  if(delivery.status!=='ready'||delivery.error)fail('une livraison V3 reste en cours ou à vérifier');
  const found=bc.shipping_orders.data.find(bl=>String(bl.id)===String(delivery.bl?.id));
  if(!found||found.status==='cancelled'||!same(quantities(delivery.selection),quantities(found.line_items)))fail('quantités du BL différentes de la livraison V3');
 }
 const ordered=quantities(bc.line_items);
 for(const [k,n] of allocated)if(!ordered.has(k)||n-ordered.get(k)>1e-6)fail('quantité allouée supérieure au BC');
 const originals=bc.line_items.filter(l=>l.type==='normal'&&l.variant?.sku===request.sku);
 if(originals.length!==1)fail('ligne du produit initial ambiguë');
 const original=originals[0],allocatedOriginal=allocated.get(key(original))||0,remaining=qty(original.quantity)-allocatedOriginal;
 if(qty(request.replaceQuantity)<=0||qty(request.replaceQuantity)-remaining>1e-6)fail('la quantité demandée empiète sur une livraison existante');
 return {shippingSignature:signature,bcId:String(bc.id),originalLineId:String(original.id),allocatedOriginal,remaining,allocated:Object.fromEntries(allocated)};
}
export function assertPartialShippingPreserved(before,after){
 if(shippingSignature(before)!==shippingSignature(after))fail('un BL a changé pendant le remplacement');
}
