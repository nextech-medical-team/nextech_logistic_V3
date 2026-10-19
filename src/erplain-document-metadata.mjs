import {readFile,writeFile}from'node:fs/promises';
import path from'node:path';
export const representativeLabels={amazon:'Amazon .fr',shopify:'NEXTECH Boutique',relay:'NEXTECH RELAIS',tender:"Appels d'offres",samples:'Commande échantillons',temu:'TEMU FR',rakuten:'RAKUTEN -'};
export function representativeLabel(o){if(o.channel==='shopify')return o.source_payload?.shopifyDeliveryMode==='relay'||o.carrier==='gls_shop'?'NEXTECH RELAIS':'NEXTECH Boutique';if(o.channel==='temu'&&o.source_payload?.temuCountry&&o.source_payload.temuCountry!=='FR')throw Error('Gestionnaire Erplain à configurer pour TEMU '+o.source_payload.temuCountry);const label=representativeLabels[o.channel];if(!label)throw Error('Gestionnaire Erplain à configurer : '+o.channel);return label;}
export function externalReference(o){const ref=String(o.reference||'').trim();if(!ref)throw Error('Référence commande absente');return ref;}
export const technicalMarker=o=>'[V3:'+o.id+']';
export async function documentMetadata(o,directory){if(o.source_payload?.erplainImported){if(o.source_payload.account!=='live'||!o.erp_live?.bc?.id)throw Error('BC Erplain LIVE requis');const bc=o.erp_live.bc;return {external_reference:bc.external_reference||bc.label,...(bc.account_representative?.id?{account_representative:{id:String(bc.account_representative.id)}}:{})};}const map=JSON.parse(await readFile(path.join(directory,'account-representatives.json'),'utf8'));if(map.sourceCompany!==100174||map.targetCompany!==100174)throw Error('Correspondance gestionnaires hors société LIVE');const label=representativeLabel(o),matches=map.rows.filter(r=>r.label===label&&r.active&&r.liveId);if(matches.length!==1)throw Error('Gestionnaire Erplain LIVE absent ou ambigu : '+label);return{external_reference:externalReference(o),account_representative:{id:String(matches[0].liveId)}};}
export async function copyRepresentatives(source,live,directory){
 const company=await live.verify();if(Number(company.id)!==100174)throw Error('Société LIVE inattendue');
 const result=await live.request('query V3Representatives {AccountRepresentatives(first:200){data{id label active} paginatorInfo{hasMorePages}}}');
 if(result.AccountRepresentatives.paginatorInfo.hasMorePages)throw Error('Pagination gestionnaires à compléter');
 const mapping={sourceCompany:100174,targetCompany:100174,verifiedAt:new Date().toISOString(),rows:result.AccountRepresentatives.data.map(r=>({sourceId:r.id,liveId:r.id,label:r.label,active:r.active}))};
 await writeFile(path.join(directory,'account-representatives.json'),JSON.stringify(mapping),{mode:0o600});return mapping;
}
export async function recoverOrder(api,o){const data=await api.request('query V3RecoverReference($where:QueryOrdersWhereWhereConditions){Orders(first:100,where:$where){data{id label status external_reference internal_notes customer{customer_number}} paginatorInfo{hasMorePages}}}',{where:{OR:[{column:'EXTERNAL_REFERENCE',operator:'EQ',value:'V3:'+o.id},{column:'EXTERNAL_REFERENCE',operator:'EQ',value:externalReference(o)}]}});const list=data?.Orders;
 if(!Array.isArray(list?.data)||typeof list.paginatorInfo?.hasMorePages!=='boolean')throw Error('API Erplain · Réponse BC incomplète : aucune nouvelle création');
 if(list.paginatorInfo.hasMorePages)throw Error('Trop de BC candidats : contrôle requis');
 const hits=[];
 for(const x of list.data){
  if(!x?.id||!x.status)throw Error('API Erplain · Réponse BC incomplète : identité absente');
  const identified=x.external_reference==='V3:'+o.id||String(x.internal_notes||'').includes(technicalMarker(o))||x.customer?.customer_number==='V3:'+o.id;
  if(!identified||!['active','unpublished'].includes(x.status))throw Error('BC de même référence ambigu ou non réutilisable : aucune nouvelle création');
  hits.push(x);
 }
 if(hits.length>1)throw Error('BC multiples pour la même commande V3');return hits[0]||null;}
