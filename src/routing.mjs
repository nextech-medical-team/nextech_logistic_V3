import {erplainTransportChannel,isImportedErplain} from './erplain-label-required.mjs';
import {defaultShopifyServices,configuredShopifyMode} from './shopify-delivery.mjs';
export const defaultInternational={product:'PARCEL',flexDelivery:true,incoterm:''};
export const defaultRouting={maxParcelKg:30,shopifyServices:defaultShopifyServices,international:defaultInternational,rules:[
 {channel:'amazon',type:'threshold',threshold:3,below:'gofo',above:'gls'},
 {channel:'shopify',type:'threshold',threshold:3,below:'gofo',above:'gls'},
 {channel:'temu',type:'fixed',fixed:'temu'},
 {channel:'tender',type:'fixed',fixed:'gls_pharma'},
 {channel:'samples',type:'fixed',fixed:'gls'},
 {channel:'relay',type:'fixed',fixed:'gls_shop'},
 {channel:'rakuten',type:'threshold',threshold:3,below:'gofo',above:'gls'}]};
export function validateRouting(c){
 const carriers=['gofo','gls','gls_pharma','gls_shop','temu'];
 if(!Number.isFinite(Number(c.maxParcelKg))||c.maxParcelKg<=0||c.maxParcelKg>30||!Array.isArray(c.rules)||!c.rules.length)throw new Error('Poids maximal GLS compris entre 0 et 30 kg requis');
 const seen=new Set();for(const r of c.rules){if(r.channel==='temu'&&(r.type!=='fixed'||r.fixed!=='temu'))throw Error('TEMU · Règle fixe étiquettes TEMU obligatoire');if(!/^[a-z][a-z0-9_]{0,49}$/.test(r.channel)||seen.has(r.channel))throw new Error('Canal absent ou dupliqué');seen.add(r.channel);
 if(r.type==='fixed'){if(!carriers.includes(r.fixed))throw new Error('Transporteur invalide');}
 else if(r.type==='threshold'){if(!(Number(r.threshold)>0)||!carriers.includes(r.below)||!carriers.includes(r.above))throw new Error('Seuil ou transporteur invalide');}
 else throw new Error('Type de règle invalide');
 }const international={...defaultInternational,...c.international};if(international.product!=='PARCEL'||typeof international.flexDelivery!=='boolean'||!['','DAP','DDP'].includes(international.incoterm))throw Error('Paramètres GLS international invalides');const shopifyServices=c.shopifyServices??defaultShopifyServices;if(!Array.isArray(shopifyServices))throw Error('Services Shopify invalides');const names=new Set();for(const r of shopifyServices){const name=String(r.service||'').trim().toLowerCase();if(!name||names.has(name)||!['direct','relay'].includes(r.mode))throw Error('Service Shopify absent, dupliqué ou mode invalide');names.add(name);}return {maxParcelKg:Number(c.maxParcelKg),international,rules:c.rules,shopifyServices:shopifyServices.map(r=>({service:r.service.trim(),mode:r.mode}))};
}
export function configuredRoute(channel,weight,config=defaultRouting,country='FR'){
 if(channel==='temu')return {carrier:'temu',weight:0.25,parcels:1};
 if(channel==='relay'){
  const rule=config.rules.find(r=>r.channel==='relay');
  if(rule?.type!=='fixed'||rule.fixed!=='gls_shop')throw Error('Relais · Règle fixe GLS ShopDelivery requise');
  if(!/^[A-Z]{2}$/.test(String(country).trim().toUpperCase()))throw Error('Pays ISO requis avant routage');
  if(!Number.isFinite(weight)||weight<=0)throw Error('Poids produit Erplain manquant');
  return {carrier:'gls_shop',weight,parcels:Math.ceil(weight/config.maxParcelKg)};
 }
 if(String(country).trim().toUpperCase()!=='FR'){if(!/^[A-Z]{2}$/.test(String(country).trim().toUpperCase()))throw Error('Pays ISO requis avant routage');if(!Number.isFinite(weight)||weight<=0)throw Error('Poids produit Erplain manquant');return {carrier:'gls',weight,parcels:Math.ceil(weight/config.maxParcelKg)};}
 const r=config.rules.find(r=>r.channel===channel);if(!r)throw new Error('Gestionnaire transport à configurer : '+channel);
 const carrier=r.type==='fixed'?r.fixed:(weight<=Number(r.threshold)?r.below:r.above);
 if(carrier==='temu')return {carrier,weight:0.25,parcels:1};
 if(!Number.isFinite(weight)||weight<=0)throw new Error('Poids produit Erplain manquant');
 return {carrier,weight,parcels:carrier.startsWith('gls')?Math.ceil(weight/config.maxParcelKg):1};
}
export async function loadRouting(db){return (await db.query("SELECT value FROM settings WHERE key='routing'")).rows[0]?.value||defaultRouting;}

export function chosenRoute(order,weight,config=defaultRouting){
 if(order.channel==='temu'&&!order.transport_choice)return configuredRoute('temu',weight,config,order.address?.country);
 const channel=erplainTransportChannel(order);
 if(isImportedErplain(order)&&channel==='tender'){
  const r=config.rules.find(r=>r.channel==='tender');
  if(r?.type!=='fixed'||r.fixed!=='gls_pharma')throw Error('Appels d’offres · Règle fixe GLS Pharma requise');
  if(String(order.address?.country).trim().toUpperCase()!=='FR')throw Error('Appels d’offres · GLS Pharma : pays hors France à vérifier avant préparation');
  return configuredRoute('tender',weight,config,order.address.country);
 }
 if(order.channel==='shopify'){
  const mode=configuredShopifyMode(order.source_payload,config);
  if(mode==='unknown')throw Error('Shopify · Mode de livraison à identifier avant préparation');
  if(mode==='relay')return configuredRoute('relay',weight,config,order.address?.country);
 }
 const carrier=order.transport_choice;
 if(!carrier)return configuredRoute(order.channel==='shopify'&&order.source_payload?.shopifyDeliveryMode==='relay'?'relay':order.channel,weight,config,order.address?.country);
 if(!['gls','gofo'].includes(carrier))throw Error('Choix transporteur non autorisé pour cette commande');
 if(carrier==='gofo'&&String(order.address?.country).trim().toUpperCase()!=='FR')throw Error('GOFO : livraison en France uniquement ; choisir GLS pour ce pays');
 return configuredRoute('manual',weight,{...config,rules:[{channel:'manual',type:'fixed',fixed:carrier}]},order.address?.country);
}
