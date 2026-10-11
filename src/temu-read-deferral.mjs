export const temuReadWaitMs=5000;
export function isTemuReadDeferred(error){return error?.code==='source_budget_deferred';}
export function temuReadDeferral(error,{reference,now=Date.now()}={}){
 const raw=String(error?.retryAfter||''),numeric=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:NaN;
 const providerDelay=Number.isFinite(numeric)?numeric:Math.max(0,Date.parse(raw)-now)||0;
 const retryAfterMs=Math.max(1000,providerDelay);
 return {reference,status:'deferred',deferred:true,error:null,code:'source_budget_deferred',message:'Lecture TEMU en attente',retryAfterMs,checkedAt:new Date(now).toISOString(),nextAt:new Date(now+retryAfterMs).toISOString()};
}
