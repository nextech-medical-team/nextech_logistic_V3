import {apiAcquireSlot,apiDefer} from './api-budget.mjs';

export function erplainBudgetKey(config){
 if(typeof config.apiKey!=='string'||!config.apiKey.trim())throw Error('Clé API Erplain requise');
 // All V3 Erplain connectors share one conservative budget, even if their
 // credentials/company headers differ. No credential is stored in this key.
 return 'erplain:shared';
}
export function erplainRetryDelay(response,attempt=0,now=Date.now()){
 const raw=response.headers?.get('retry-after')?.trim();
 let requested=NaN;
 if(raw){requested=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now;}
 if(Number.isFinite(requested)&&requested>=0)return Math.max(1000,requested);
 return Math.min(900000,60000*2**Math.min(attempt,4));
}
// API v2 documents 2 HTTP calls/second; retain a 100 ms safety margin.
// Other endpoints keep their existing conservative pacing.
export function erplainRequestInterval(url){const u=new URL(url);return u.origin==='https://api.erplain.app'&&u.pathname==='/graphql'?600:1600;}
export const erplainQuotaWaitMs=15000;
export async function erplainFetch(config,url,buildOptions,{fetchImpl=fetch,readOnly=false,slot=apiAcquireSlot,defer=apiDefer}={}){
 const key=erplainBudgetKey(config);
 for(let attempt=0;;attempt++){
  try{await slot(key,erplainRequestInterval(url),{fair:true,maxWaitMs:erplainQuotaWaitMs});}
  catch(error){
   if(error?.code!=='source_budget_deferred')throw error;
   // Admission failed before fetch: no provider request was sent. Release the
   // order worker rather than hold processing and shipment locks indefinitely.
   throw Object.assign(Error('Erplain HTTP 429 · attente du quota partagé différée, aucune requête envoyée'),{code:'erplain_budget_deferred',httpStatus:429,erplainReadOnly:readOnly,erplainRequestNotSent:true,erplainProviderRateLimited:attempt>0,retryAfter:Math.max(2,Number(error.retryAfter)||2)});
  }
  // Build the timeout after waiting, so a shared pause cannot expire it.
  let response=await fetchImpl(url,buildOptions());
  // A GraphQL rejection can use HTTP 200. Only a complete, explicit rejection
  // without any data is equivalent to HTTP 429; partial results stay intact.
  if(response.ok&&new URL(url).pathname==='/graphql'){
   try{
    const payload=await response.clone().json();
    const errors=Array.isArray(payload?.errors)?payload.errors:[],hasRate=errors.some(e=>e?.extensions?.code==='RATE_LIMITED');
    if(errors.length>0&&errors.every(e=>e?.extensions?.code==='RATE_LIMITED')&&(payload?.data==null||readOnly)){
     const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
     response=new Response(JSON.stringify(payload),{status:429,headers});
    }else if(hasRate){
     // Preserve accepted mutation data and real business errors, but slow all connectors.
     await defer(key,erplainRetryDelay(response,attempt));
    }
   }catch{/* Preserve malformed/uncertain responses for the caller; no replay. */}
  }
  if(response.status!==429)return response;
  await defer(key,erplainRetryDelay(response,attempt));
  // Never replay writes, network failures, 5xx or an uncertain response.
  if(!readOnly||attempt>=3)return response;
  await response.body?.cancel?.().catch(()=>{});
 }
}
