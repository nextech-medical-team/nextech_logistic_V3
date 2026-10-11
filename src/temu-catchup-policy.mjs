export const temuCatchupCadence=Object.freeze({scan:15*60000,normal:15*60000,retry:[2,5,15,30,60].map(n=>n*60000),alert:60*60000,escalate:4*60*60000});
export function temuCatchupDelay(failures,retryAfterMs=0){
 if(!Number.isSafeInteger(failures)||failures<1||!Number.isFinite(retryAfterMs)||retryAfterMs<0)throw Error('Invalid TEMU retry delay');
 return Math.max(temuCatchupCadence.retry[Math.min(failures-1,4)],retryAfterMs);
}
export function temuSourceError(error,field){
 const message=String(error?.message||error).slice(0,450),match=message.match(/\b(180020006|3000032|5000003)\b/);
 const status=error?.status||Number(message.match(/\bHTTP\s+(\d{3})\b/)?.[1]);
 let retryAfterMs=0;const raw=error?.retryAfter;
 if(typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw))retryAfterMs=Math.ceil(Number(raw)*1000);
 else if(typeof raw==='string'&&/GMT$/.test(raw)&&Number.isFinite(Date.parse(raw)))retryAfterMs=Math.max(0,Date.parse(raw)-Date.now());
 return {code:match?.[1]||error?.code||(status?'HTTP_'+status:'TEMU_READ_FAILED'),field,message,retryAfterMs};
}
// Only a pure obsolete source refusal can be superseded by a complete fresh read.
// Mixed messages and the historical job records remain intact.
export function obsoleteTemuVisibilityError(message){return typeof message==='string'&&/^TEMU(?: refuse l.opération\s*:\s*|\s*·\s*)180020006\s+The current order status cannot be viewed\.?\s*$/i.test(message);}
