import {erplainFetch,erplainRetryDelay} from './erplain-transport.mjs';
import {apiBudgetDelay} from './api-budget.mjs';
import {sharedErplainReference} from './erplain-reference-cache.mjs';
import {guardErplainReadyMutation} from './erplain-ready-transition.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
export function confirmedRateLimitRejection(payload){
 return payload?.data==null&&Array.isArray(payload?.errors)&&payload.errors.length>0&&payload.errors.every(e=>e?.extensions?.code==='RATE_LIMITED');
}
export function erplainBatchError(result,alias,phase){
 const detail=result?._v3Errors?.find(e=>e.path?.[0]===alias);
 const limited=detail?.code==='RATE_LIMITED';
 const error=new Error(limited?'Erplain HTTP 429 · '+detail.message:detail?.message||'Réponse incomplète '+phase);
 if(limited){error.httpStatus=429;error.erplainReadOnly=false;error.confirmedRateLimitRejection=false;}
 return error;
}
export function erplainAccount(directory,account,{fetchImpl=fetch,loadConfig=async()=>JSON.parse(await readFile(path.join(directory,'erplain-live.json'),'utf8'))}={}){
 if(!['source','live'].includes(account))throw new Error('Seul ERPLAIN LIVE est disponible');
 const expected=100174;let identity=false;
 async function request(query,variables={},attempt=0,partial=false){
  const mutation=/^mutation\s/.test(query);if(!/^query\s/.test(query)&&!mutation)throw new Error('Opération interdite');
  if((mutation||/\bmutation\b/i.test(query))&&(account!=='live'||process.env.ERPLAIN_LIVE_WRITES!=='1'||process.env.MIGRATION_PREPARATION==='1'||!identity))throw new Error('ERPLAIN LIVE : écriture non autorisée ou identité non vérifiée');
  if(process.env.MIGRATION_PREPARATION==='1'&&/\b(?:Orders|Order|ShippingOrders|ShippingOrder|Invoices|Invoice|Estimates|PurchaseOrders)\s*\(/.test(query))throw new Error('ERPLAIN LIVE : commandes suspendues jusqu’au GO');
  if(mutation)await guardErplainReadyMutation(query,variables,request);
  const c=await loadConfig();
  if(c.url!=='https://api.erplain.app/graphql'||Number(c.companyId)!==expected)throw new Error('Configuration ERPLAIN LIVE incohérente');
  const perform=async()=>{
  const response=await erplainFetch(c,c.url,()=>({method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{'content-type':'application/json',authorization:'Bearer '+c.apiKey,'x-company-id':String(expected)},body:JSON.stringify({query,variables})}),{fetchImpl,readOnly:!mutation&&!/\bmutation\b/i.test(query)});
  if(!response.ok){const e=new Error('Erplain HTTP '+response.status);e.retryAfter=erplainRetryDelay(response)/1000;e.httpStatus=response.status;e.erplainReadOnly=!mutation&&!/\bmutation\b/i.test(query);if(response.status===429&&mutation){try{e.confirmedRateLimitRejection=confirmedRateLimitRejection(await response.json());}catch{e.confirmedRateLimitRejection=false;}}throw e;}
  const j=await response.json();if(partial&&j.data)return {...j.data,_v3Errors:(j.errors||[]).map(e=>({path:e.path,code:e.extensions?.code,message:String(e.message).replaceAll(c.apiKey,'[secret]').slice(0,400)}))};if(j.errors?.length&&j.errors.every(e=>e?.extensions?.code==='RATE_LIMITED')){const e=Error('Erplain HTTP 429 · réponse partielle à rapprocher');e.httpStatus=429;e.erplainReadOnly=!mutation;e.retryAfter=erplainRetryDelay(response)/1000;e.confirmedRateLimitRejection=false;throw e;}if(j.errors)throw new Error(j.errors.map(e=>e.message+' '+JSON.stringify(e.extensions?.validation||{})).join('; ').replaceAll(c.apiKey,'[secret]').slice(0,1000));return j.data;
  };
  return partial?perform():sharedErplainReference(c,query,variables,fetchImpl,perform);
 }
 return {request,quotaDelay:()=>apiBudgetDelay('erplain:shared'),async verify(){identity=false;const {Company}=await request('query V3CheckAccount { Company { id label } }');if(Company?.id!==expected)throw new Error('Identité Erplain incorrecte');identity=true;return Company;}};
}
