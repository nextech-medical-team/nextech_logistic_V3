import {shopIdentity} from './import-reception.mjs';
import {readFile,writeFile}from'node:fs/promises';
import path from'node:path';
export const representativeLabels={amazon:'Amazon .fr',shopify:'NEXTECH Boutique',relay:'NEXTECH RELAIS',tender:"Appels d'offres",samples:'Commande échantillons',temu:'TEMU FR',rakuten:'RAKUTEN -'};
export function representativeLabel(o){if(o.channel==='shopify')return o.source_payload?.shopifyDeliveryMode==='relay'||o.carrier==='gls_shop'?'NEXTECH RELAIS':'NEXTECH Boutique';if(o.channel==='temu'){const raw=String(o.source_payload?.temuCountry||o.address?.country||o.source_payload?.country||'').trim().toUpperCase(),country=({FRANCE:'FR',EL:'GR',UK:'GB'})[raw]||raw;return country?'TEMU '+country:'TEMU origine à préciser';}const label=representativeLabels[o.channel];if(!label)throw Error('Gestionnaire Erplain à configurer : '+o.channel);return label;}
export function externalReference(o){const ref=String((o.source_payload?.importIdentityReference?o.source_reference:o.reference)||'').trim();if(!ref)throw Error('Référence commande absente');return ref;}
export const technicalMarker=o=>'[V3:'+o.id+']';
export async function documentMetadata(o,directory){if(o.source_payload?.erplainImported){if(o.source_payload.account!=='live'||!o.erp_live?.bc?.id)throw Error('BC Erplain LIVE requis');const bc=o.erp_live.bc;return {external_reference:bc.external_reference||bc.label,...(bc.account_representative?.id?{account_representative:{id:String(bc.account_representative.id)}}:{})};}let map;try{map=JSON.parse(await readFile(path.join(directory,'account-representatives.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;o.erp_live??={};o.erp_live.accountRepresentativeObservation={status:'missing_configuration',channel:o.channel,blocking:false};return {external_reference:externalReference(o)};}if(map.sourceCompany!==100174||map.targetCompany!==100174)throw Error('Correspondance gestionnaires hors société LIVE');const label=representativeLabel(o),matches=map.rows.filter(r=>r.label===label&&r.active&&r.liveId);if(matches.length!==1){o.erp_live??={};o.erp_live.accountRepresentativeObservation={status:matches.length?'ambiguous':'missing',label,channel:o.channel,blocking:false};return {external_reference:externalReference(o)};}return{external_reference:externalReference(o),account_representative:{id:String(matches[0].liveId)}};}
export async function copyRepresentatives(source,live,directory){
 const company=await live.verify();if(Number(company.id)!==100174)throw Error('Société LIVE inattendue');
 const result=await live.request('query V3Representatives {AccountRepresentatives(first:200){data{id label active} paginatorInfo{hasMorePages}}}');
 if(result.AccountRepresentatives.paginatorInfo.hasMorePages)throw Error('Pagination gestionnaires à compléter');
 const mapping={sourceCompany:100174,targetCompany:100174,verifiedAt:new Date().toISOString(),rows:result.AccountRepresentatives.data.map(r=>({sourceId:r.id,liveId:r.id,label:r.label,active:r.active}))};
 await writeFile(path.join(directory,'account-representatives.json'),JSON.stringify(mapping),{mode:0o600});return mapping;
}
export async function recoverOrder(api,o,{db}={}){
 const reference=externalReference(o);
 const data=await api.request('query V3RecoverReference($where:QueryOrdersWhereWhereConditions){Orders(first:100,where:$where){data{id label status external_reference internal_notes} paginatorInfo{hasMorePages}}}',{where:{OR:[{column:'EXTERNAL_REFERENCE',operator:'EQ',value:'V3:'+o.id},{column:'EXTERNAL_REFERENCE',operator:'EQ',value:reference}]}});
 const orders=data?.Orders;
 if(orders?.paginatorInfo?.hasMorePages===true)throw Error('Trop de BC candidats : contrôle requis');
 if(!Array.isArray(orders?.data)||orders.paginatorInfo?.hasMorePages!==false||orders.data.some(x=>!/^\d+$/.test(String(x?.id||''))))throw Error('Recherche BC Erplain incomplète : aucune nouvelle création');
 const candidates=orders.data;
 // A customer number identifies a reusable customer, never a sales order.
 const marked=(document,owner)=>document.external_reference==='V3:'+owner.id||String(document.internal_notes||'').includes(technicalMarker(owner));
 const own=x=>marked(x,o),unrelated=new Set();
 if(db&&candidates.some(x=>!own(x))){
  const owners=(await db.query("SELECT id,channel,source_payload,erp_live FROM orders WHERE id<>$1 AND erp_live->'bc'->>'id'=ANY($2::text[])",[o.id,candidates.map(x=>String(x.id))])).rows;
  for(const candidate of candidates){
   const matches=owners.filter(owner=>String(owner.erp_live?.bc?.id)===String(candidate.id));
   if(own(candidate)||matches.length!==1)continue;
   const owner=matches[0],marketplaces=new Set(['amazon','shopify','temu']);
   const otherPlatform=marketplaces.has(o.channel)&&marketplaces.has(owner.channel)&&o.channel!==owner.channel;
   const otherShop=o.channel==='shopify'&&owner.channel==='shopify'&&shopIdentity(o)&&shopIdentity(owner)&&shopIdentity(o)!==shopIdentity(owner);
   if(marked(candidate,owner)&&(otherPlatform||otherShop))unrelated.add(String(candidate.id));
  }
 }
 const activeOwned=candidates.filter(x=>x.status!=='cancelled'&&own(x));
 if(activeOwned.length>1)throw Error('BC multiples pour la même commande V3');
 const cancelled=candidates.filter(x=>x.status==='cancelled'&&(own(x)||x.external_reference===reference)&&!unrelated.has(String(x.id)));
 const previousId=String(o.erp_live?.previousCancelledCycle?.bc?.id||'');
 if(cancelled.some(x=>!activeOwned.length||String(x.id)!==previousId))throw Error('BC annulé dans Erplain : rapprochement requis, aucune nouvelle création automatique');
 const unmarked=candidates.filter(x=>x.status!=='cancelled'&&x.external_reference===reference&&!own(x)&&!unrelated.has(String(x.id)));
 if(unmarked.length)throw Error('BC existant de même référence à rapprocher avant création');
 return activeOwned[0]||null;
}
