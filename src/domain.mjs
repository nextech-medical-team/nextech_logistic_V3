export const DIMENSIONS_CM={length:10,width:8,height:0.5};
export const ROLES=['admin','manager','operator','accounting','viewer'];
export function channelName(value){
  const s=String(value??'').trim().toLowerCase();
  return ({amazon:'amazon',shopify:'shopify',temu:'temu',"appels d’offres":'tender',"appels d'offres":'tender'})[s]||s;
}
export function convertedQuantity(quantity,source,target){
  const n=Number(quantity)*Number(target)/Number(source);
  if(!Number.isFinite(n)||n<=0) throw new Error('Conversion de quantité invalide');
  return Math.round(n*1e6)/1e6;
}
export function route(channel,weight){
  if(channel==='temu')return {carrier:'temu',weight:0.25,parcels:1};
  if(!Number.isFinite(weight)||weight<=0)throw new Error('Poids produit Erplain manquant');
  const fixed={tender:'gls_pharma',samples:'gls',relay:'gls_shop'};
  const carrier=fixed[channel]||(['amazon','shopify'].includes(channel)?(weight<=3?'gofo':'gls'):null);
  if(!carrier)throw new Error('Gestionnaire transport à configurer');
  return {carrier,weight,parcels:carrier.startsWith('gls')?Math.ceil(weight/30):1};
}
export function addressIssue(a){
  const missing=[['name','destinataire'],['street','adresse'],['postal','code postal'],['city','ville'],['country','pays']].filter(([k])=>!String(a[k]||'').trim()).map(([,label])=>label);
  return missing.length?'Informations transport manquantes : '+missing.join(', '):null;
}
// Production calls are deliberately not implemented in this milestone.
// An endpoint string or credential alone can never enable a remote mutation.
export function enforceOperation(provider,operation,environment){
  const read={erplain:['products.read','orders.read','shipping.read','invoices.read'],shopify:['orders.read','products.read'],temu:['orders.read','tracking.read']};
  if(environment==='production'&&!read[provider]?.includes(operation))throw new Error('Écriture de production interdite');
  if(!['production','sandbox','simulation'].includes(environment))throw new Error('Environnement interdit');
  return true;
}
