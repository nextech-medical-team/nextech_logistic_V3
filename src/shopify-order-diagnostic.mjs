import {loadShopifyConfig,shopifyCollector} from './marketplace-collection.mjs';
export function shopifyDiagnosticReader(db,directory,{loadConfig=loadShopifyConfig,collector=shopifyCollector,now=()=>new Date()}={}){
 let client,configKey;
 return {async read(id){
  const order=(await db.query('SELECT id,channel,reference,source_payload,archived FROM orders WHERE id=$1',[id])).rows[0];
  if(!order||order.archived||order.channel!=='shopify')throw Error('Shopify · Commande active non identifiée');
  const config=await loadConfig(directory),shop=String(config.SHOPIFY_STORE_DOMAIN||'').trim().toLowerCase();
  if(!shop||shop!==String(order.source_payload?.sourceShop||'').trim().toLowerCase())throw Error('Shopify · Boutique source différente de la connexion');
  if(!/^\d+$/.test(String(order.source_payload?.id||'')))throw Error('Shopify · Identifiant source absent');
  const key=JSON.stringify(config);if(!client||configKey!==key){client=collector(config);configKey=key;}
  const result=await client.order(order.source_payload.id,{remaining:true});
  if(result?.snapshot?.id!=='gid://shopify/Order/'+order.source_payload.id||result?.payload?.name!==order.reference)throw Error('Shopify · Identité de commande différente de la source');
  if(typeof result.snapshot.status!=='string'||!result.snapshot.status||!Array.isArray(result.snapshot.lines))throw Error('Shopify · État ou articles source incomplets');
  return {provider:'Shopify',readOnly:true,reference:order.reference,checkedAt:now().toISOString(),sourceStatus:result.snapshot.status,cancelledAt:result.payload.cancelled_at,lines:result.snapshot.lines,errors:[],message:'Commande relue depuis Shopify · état source '+result.snapshot.status+(result.payload.cancelled_at?' · annulation enregistrée':'')+'. Les documents, la préparation et les corrections encore présentes restent à vérifier. Aucune reprise métier effectuée.'};
 }};
}
