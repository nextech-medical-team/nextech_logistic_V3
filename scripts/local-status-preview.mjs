// This module exposes only fixed GraphQL queries. No mutation or arbitrary query input.
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {erplainAccount} from '../src/erplain-accounts.mjs';
export function statusPreview({api,db}){
 let busy=false;
 return async function compare(input){
  const refs=input?.references;
  if(!Array.isArray(refs)||!refs.length||refs.length>5||refs.some(r=>typeof r!=='string'||!r.trim()||r.length>150))throw Error('Saisissez de 1 à 5 références de commande.');
  if(busy)throw Error('Une lecture est déjà en cours.');busy=true;
  try{
   const company=await api.verify();if(Number(company.id)!==100174)throw Error('La connexion ne correspond pas à Erplain PROD 100174.');
   const rows=[];
   for(const reference of [...new Set(refs.map(r=>r.trim()))]){
    const {Orders:found}=await api.request('query LocalStatusPreview($where:QueryOrdersWhereWhereConditions){Orders(first:20,where:$where){data{id label status external_reference shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'EXTERNAL_REFERENCE',operator:'EQ',value:reference}});
    if(!found||found.paginatorInfo?.hasMorePages||found.data.some(b=>b.shipping_orders?.paginatorInfo?.hasMorePages))throw Error('Résultat incomplet : '+reference);
    const local=(await db.query('SELECT * FROM orders WHERE reference=$1',[reference])).rows[0];
    rows.push({reference,documents:found.data,local:local?{bc:local.erp_live?.bc||null,bl:local.erp_live?.bl||null,tracking:local.tracking_status||null}:null,notice:found.data.length>1?'Plusieurs BC correspondent : contrôle nécessaire.':!found.data.length?'Aucun BC PROD trouvé pour cette référence externe.':!local?.erp_live?.bc?'Statut PROD local absent : aucune différence ne peut être conclue.':'Comparer les statuts affichés.'});
   }
   return {company,readAt:new Date().toISOString(),rows};
  }finally{busy=false;}
 };
}
export async function localProductionReader(db){
 const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
 if(!env.ERPLAIN_API_KEY)throw Error('Accès de lecture Erplain PROD absent de la configuration locale.');
 const account=erplainAccount('', 'source',{loadConfig:async()=>({url:'https://api.erplain.app/graphql',companyId:100174,apiKey:env.ERPLAIN_API_KEY})});
 // Source account rejects mutations regardless of ERPLAIN_LIVE_WRITES.
 return statusPreview({api:account,db});
}
