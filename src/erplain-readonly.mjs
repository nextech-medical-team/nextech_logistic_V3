import {stockChoiceLocation} from './stock-choice-location.mjs';
import {chooseActiveStockVariant} from './active-stock-choice.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {erplainFetch} from './erplain-transport.mjs';
import {businessWeight} from './weight-business-policy.mjs';
import {cacheProviderWeight,weightVariantForCache} from './product-weight-cache.mjs';
// The connector owns its query. No caller can submit GraphQL or a mutation.
const QUERY=`query V3ProductWeight($where: QueryVariantsWhereWhereConditions, $first: Int, $page: Int) {
 Variants(where:$where, first:$first, page:$page) {
  data { id sku weight_amount weight_unit active product { id active } stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}} }
 }
}`;
export function validateConfig(input){
 let url;try{url=new URL(input.url);}catch{throw new Error('Adresse GraphQL Erplain invalide');}
 if(url.protocol!=='https:'||!(url.hostname==='api.erplain.app'||url.hostname==='erplain.com'||url.hostname.endsWith('.erplain.com'))||url.username||url.password||url.search||url.hash||url.port)throw new Error('Adresse HTTPS officielle Erplain requise, sans paramètres ni identifiants dans l’URL');
 if(typeof input.apiKey!=='string'||!input.apiKey.trim()||/[\r\n]/.test(input.apiKey))throw new Error('Clé API Erplain requise');
 const companyId=String(input.companyId||'').trim();if(companyId!=='100174'||url.href!=='https://api.erplain.app/graphql')throw new Error('Seule la société ERPLAIN LIVE 100174 est autorisée');
 return {url:url.href,apiKey:input.apiKey.trim(),companyId};
}
// Shared human business policy: missing weight = 5 g; only explicit kg means kg.
// Keep source values untouched; all callers receive kilograms exactly once.
export function erplainWeightKg(weightAmount,weightUnit){
 return businessWeight(weightAmount,weightUnit).weightKg;
}
export function resolveWeight(data,sku,selection={}){
 if(!Array.isArray(data))throw new Error('Réponse catalogue Erplain invalide');
 const exact=data.filter(x=>String(x.sku||'').trim()===sku);
 const active=exact.filter(x=>x.active!==false&&x.product?.active!==false);
 if(!exact.length)throw new Error('Produit introuvable dans Erplain');if(!active.length)throw new Error('Produit ou variante inactif dans Erplain');if(active.length>1&&!selection.locationId)throw new Error('Plusieurs produits Erplain actifs portent ce SKU');
 const item=(active.length>1||selection.variantId!=null)?chooseActiveStockVariant(data,{sku,...selection}).variant:active[0];
 return {weightKg:erplainWeightKg(item.weight_amount,item.weight_unit),variantId:String(item.id)};
}
export async function fetchVariants(config,skus,{fetchImpl=fetch}={}){
 const c=validateConfig(config);if(!Array.isArray(skus)||!skus.length||skus.length>20||skus.some(sku=>typeof sku!=='string'||!sku.trim()||sku.length>300))throw new Error('SKU invalide');
 let response;
 try{response=await erplainFetch(c,c.url,()=>({method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',accept:'application/json',authorization:`Bearer ${c.apiKey}`,...(c.companyId?{'x-company-id':c.companyId}:{})},body:JSON.stringify({query:QUERY,variables:{where:{AND:[{column:'SKU',operator:skus.length===1?'EQ':'IN',value:skus.length===1?skus[0]:skus}]},first:100,page:1}})}),{fetchImpl,readOnly:true});}catch{throw new Error('Connexion Erplain impossible (réseau, certificat ou délai dépassé)');}
 if(!response.ok){const e=new Error(`Lecture Erplain refusée (HTTP ${response.status})`);e.fatal=[401,403].includes(response.status);e.retryable=response.status===429||response.status>=500;const retry=response.headers.get('retry-after');if(retry){const seconds=Number(retry);const ms=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now();if(Number.isFinite(ms)&&ms>=0)e.retryAfterMs=ms;}throw e;}
 const bytes=await response.arrayBuffer();if(bytes.byteLength>2*1024*1024)throw new Error('Réponse Erplain trop volumineuse');
 let payload;try{payload=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw new Error('Réponse Erplain non JSON');}
 if(payload.errors?.length){const e=new Error('Erplain a refusé la requête de lecture : vérifier l’adresse GraphQL, les droits et la société');e.fatal=true;throw e;}
 const variants=payload.data?.Variants?.data;
 if(variants?.length===100)throw new Error('Résultat Erplain ambigu : trop de variantes');
 if(!Array.isArray(variants))throw new Error('Réponse catalogue Erplain invalide');
 return variants;
}
export async function fetchWeight(config,sku,options){return resolveWeight(await fetchVariants(config,[sku],options),sku,options?.selection);}
export function createCatalogSync(db,directory,{fetchImpl=fetch,delayMs=5000,batchSize=20,now=Date.now,schedule=setTimeout,cancelSchedule=clearTimeout}={}){
 const configPath=path.join(directory,'erplain-readonly.json');
 const retryPath=path.join(directory,'erplain-retry.json');
 let state={running:false,configured:false,done:0,total:0,loaded:0,errors:[],lastRun:null,error:null,nextRetryAt:null,retryCount:0};
 let retryTimer=null,restored=false,stopped=false;
 let activeRun=Promise.resolve();
 let requested=false;
 function armRetry(){if(retryTimer)cancelSchedule(retryTimer);retryTimer=schedule(()=>{retryTimer=null;return start().catch(()=>{});},Math.min(2147483647,Math.max(0,Date.parse(state.nextRetryAt)-now())));retryTimer?.unref?.();}
 async function deferRetry(e){state.retryCount++;const delay=Math.max(e.retryAfterMs||0,Math.min(900000,60000*2**Math.min(state.retryCount-1,4)));state.nextRetryAt=new Date(now()+delay).toISOString();state.error='Erplain temporairement indisponible ou limité ; reprise automatique programmée.';await writeFile(retryPath,JSON.stringify({nextRetryAt:state.nextRetryAt,retryCount:state.retryCount}),{mode:0o600});if(!stopped)armRetry();}
 async function restoreRetry(){if(restored)return;restored=true;try{const saved=JSON.parse(await readFile(retryPath,'utf8'));if(Number.isFinite(Date.parse(saved.nextRetryAt))){state.nextRetryAt=saved.nextRetryAt;state.retryCount=Number(saved.retryCount)||0;}}catch(e){if(e.code!=='ENOENT')throw new Error('État de reprise Erplain illisible');}}
 async function readConfig(){try{return validateConfig(JSON.parse(await readFile(configPath,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function status(){let configured=false;try{configured=!!await readConfig();}catch{}return {...state,configured,mode:'production-readonly',cached:Number((await db.query("SELECT count(*) AS n FROM products WHERE origin='erplain_readonly'")).rows[0].n)};}
 async function saveConfig(input){if(state.running)throw new Error('Synchronisation en cours ; attendre avant de modifier la connexion');const c=validateConfig(input);await writeFile(configPath+'.tmp',JSON.stringify(c),{mode:0o600});await rename(configPath+'.tmp',configPath);return {configured:true};}
 async function run(config){
  state={...state,running:true,done:0,total:0,loaded:0,errors:[],error:null,lastRun:new Date().toISOString()};
  try{
   const {rows}=await db.query(`SELECT DISTINCT coalesce(l.target_sku,m.target_sku,l.source_sku) AS sku FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku LEFT JOIN products p ON p.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) WHERE NOT o.archived AND (p.sku IS NULL OR p.updated_at<now()-interval '24 hours') ORDER BY sku`);
   const skus=rows.map(x=>x.sku).filter(Boolean);state.total=skus.length;
   let batch=[];
   for(const [index,sku] of skus.entries()){
    if(stopped)break;
    if(index>0&&index%batchSize===0)await new Promise(r=>setTimeout(r,delayMs));
    try{
     if(index%batchSize===0){batch=[];try{batch=await fetchVariants(config,skus.slice(index,index+batchSize),{fetchImpl});}catch(e){e.fatal=true;throw e;}}
     const variant=await weightVariantForCache(db,batch,sku,()=>stockChoiceLocation(directory));
     await cacheProviderWeight(db,variant);
     await db.transaction(async tx=>{
      await tx.query(`UPDATE jobs j SET status='pending',available_at=now(),error=null FROM orders o WHERE o.id=j.order_id AND j.kind='label' AND j.status='blocked' AND EXISTS(SELECT 1 FROM lines l LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=o.id AND coalesce(l.target_sku,m.target_sku,CASE WHEN o.channel IN ('tender','samples') THEN l.source_sku END)=$1)`,[sku]);
     });state.loaded++;
    }catch(e){
     if(e.retryable||e.message.startsWith('Connexion Erplain')){await deferRetry(e);break;}
     state.errors.push({sku,message:e.message});
     if(e.fatal||e.message.startsWith('Connexion Erplain')){state.error=e.message;break;}
     await db.query(`INSERT INTO catalog_results(sku,message,checked_at) VALUES($1,$2,now()) ON CONFLICT(sku) DO UPDATE SET message=EXCLUDED.message,checked_at=now()`,[sku,e.message]);
    }
    state.done++;
   }
   await db.query(`UPDATE jobs SET status='pending',available_at=now() WHERE kind='label' AND status='blocked'`);
   if(!state.nextRetryAt&&!state.error){state.retryCount=0;await writeFile(retryPath,JSON.stringify({nextRetryAt:null,retryCount:0}),{mode:0o600});}
  }catch{state.error='Synchronisation interrompue ; les poids déjà reçus sont conservés.';}finally{state.running=false;}
 }
 async function start(){if(stopped)return status();if(state.running){requested=true;return status();}state.running=true;let config;try{await restoreRetry();if(state.nextRetryAt&&Date.parse(state.nextRetryAt)>now()){state.running=false;armRetry();return status();}state.nextRetryAt=null;if(retryTimer){cancelSchedule(retryTimer);retryTimer=null;}config=await readConfig();if(!config)throw new Error('Connexion Erplain non configurée : renseigner les paramètres dans Connexions');}catch(e){state.running=false;throw e;}activeRun=(async()=>{do{requested=false;await run(config);if(state.error||stopped)break;state.running=requested;}while(requested);state.running=false;})();return status();}
 return {status,saveConfig,start,wait:()=>activeRun,stop(){stopped=true;if(retryTimer)cancelSchedule(retryTimer);}};
}
