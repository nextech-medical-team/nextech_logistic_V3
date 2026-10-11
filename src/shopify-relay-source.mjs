import {shopifyDeliveryMode} from './shopify-delivery.mjs';
const has=(v,k)=>Object.prototype.hasOwnProperty.call(v||{},k);
export function validShopId(value){return /^GLS_[A-Z]{2}-[A-Za-z0-9]+$/.test(String(value||''));}
function optionalId(value){if(value===null||value===undefined||value==='')return null;if(!validShopId(value))throw Error('GLS · Identifiant relais Shopify invalide');return String(value);}
export function normalizeRelayAddress(a={}){
 return {name:a.name||[a.first_name??a.firstName,a.last_name??a.lastName].filter(Boolean).join(' '),
 street:[a.address1,a.address2].filter(Boolean).join(', '),postal:a.zip||'',city:a.city||'',
 country:a.country_code||a.countryCodeV2||'',phone:a.phone||''};
}
export function readShopifyRelay(source){
 if(shopifyDeliveryMode(source)!=='relay')return null;
 if(!has(source,'glsRelayId')||!has(source,'glsRelayMetadata'))return null;
 if(!/^\d+$/.test(String(source.id))||!source.name||!Number.isFinite(Date.parse(source.updated_at))||Date.parse(source.updated_at)>Date.now())throw Error('GLS · Identité ou version Shopify non vérifiable');
 let metadata={};if(source.glsRelayMetadata?.value){try{metadata=JSON.parse(source.glsRelayMetadata.value);}catch{throw Error('GLS · Métadonnées relais Shopify illisibles');}}
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('GLS · Métadonnées relais Shopify invalides');
 const declaredId=optionalId(metadata.selectedRelais),selectedId=metadata.isPreselected===true?null:declaredId,defaultId=optionalId(metadata.defaultRelais),sourceId=optionalId(source.glsRelayId?.value);
 if(declaredId&&sourceId&&declaredId!==sourceId)throw Error('GLS · Sélection relais Shopify contradictoire');
 const original=metadata.originalShippingAddress;
 if(original!==undefined&&original!==null&&(typeof original!=='object'||Array.isArray(original)))throw Error('GLS · Adresse client d’origine invalide');
 if(declaredId&&!original)throw Error('GLS · Adresse client d’origine non reçue pour le relais choisi');
 return {source:'shopify_gls_france',sourceId:String(source.id),reference:String(source.name),sourceVersion:source.updated_at,
  observedAt:new Date().toISOString(),metadataComplete:true,selectedId,defaultId,sourceIdFallback:sourceId,
  selection:selectedId?'customer_selected':'nearest_required',
  originalShippingAddress:original||null,clientAddress:normalizeRelayAddress(original||source.shipping_address||{}),
  destinationAddress:selectedId?normalizeRelayAddress(source.shipping_address||{}):null};
}
export function assertFreshShopifyRelay(order,{now=Date.now(),maxAge=60000}={}){
 const r=order.source_payload?.shopifyRelay;
 if(!r||r.metadataComplete!==true||r.source!=='shopify_gls_france'||r.reference!==order.reference||r.sourceId!==String(order.source_payload?.id))throw Error('GLS · Choix relais Shopify à relire avant création');
 const age=now-Date.parse(r.observedAt);if(!Number.isFinite(age)||age<0||age>maxAge)throw Error('GLS · Choix relais Shopify expiré avant création');
 if(r.selectedId&&!validShopId(r.selectedId))throw Error('GLS · Relais choisi invalide');
 return r;
}
export function chooseNearestParcelShop(shops){
 if(!Array.isArray(shops)||!shops.length)throw Error('GLS · Aucun relais trouvé');
 if(shops.some(s=>!validShopId(s.parcelShopId)||!Number.isFinite(s.distance)||s.distance<0))throw Error('GLS · Distances ou identités des relais non reçues ou invalides');
 return [...shops].sort((a,b)=>a.distance-b.distance||a.parcelShopId.localeCompare(b.parcelShopId))[0];
}
const addressKey=a=>JSON.stringify(['name','street','postal','city','country'].map(k=>String(a?.[k]||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleUpperCase('fr')));
export function relayComparisonAddress(order,incomingRelay){
 let r=order.source_payload?.shopifyRelay;
 if(!r&&incomingRelay?.metadataComplete===true&&incomingRelay.reference===order.reference&&incomingRelay.sourceId===String(order.source_payload?.id)&&incomingRelay.destinationAddress&&sameRelayAddress(order.address,normalizeRelayAddress(order.source_payload.shipping_address||{}))&&sameRelayAddress(order.address,incomingRelay.destinationAddress))return incomingRelay.clientAddress;
 if(order.channel!=='shopify'||r?.metadataComplete!==true||r.reference!==order.reference||r.sourceId!==String(order.source_payload.id))return order.address;
 const current=addressKey(order.address);
 if([r.clientAddress,r.destinationAddress,normalizeRelayAddress(order.source_payload.shipping_address||{})].filter(Boolean).some(a=>addressKey(a)===current))return r.clientAddress;
 return order.address; // An explicit local address edit is never hidden.
}
export function sameRelayAddress(a,b){return addressKey(a)===addressKey(b);}
