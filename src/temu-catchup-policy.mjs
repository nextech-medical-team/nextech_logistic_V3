export const temuCatchupCadence=Object.freeze({scan:2*60000,normal:15*60000,retry:[2,5,15,30,60].map(n=>n*60000),alert:60*60000,escalate:4*60*60000});
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
export function obsoleteTemuVisibilityError(message){
 if(typeof message!=='string')return false;
 const parts=message.split(/\s;\s/),refusal=part=>/^TEMU(?: refuse l.opération\s*:\s*|\s*·\s*)180020006\s+The current order status cannot be viewed\.?\s*$/i.test(part);
 // A current, stable detail supersedes the earlier list absence as well.
 // Any independent diagnostic in the same message still prevents replacement.
 return parts.some(refusal)&&parts.every(part=>refusal(part)||part==='TEMU · Commande absente de la liste source');
}

export function pureTemuSourceReadError(message){
 return obsoleteTemuVisibilityError(message)||typeof message==='string'&&message.split(/\s;\s/).every(part=>obsoleteTemuVisibilityError(part)||/^TEMU refuse l.opération\s*:\s*3000032 access_token don't have this api access, please ask for seller to authorize this api in seller center first\.and share the new access_token with you\.\s*$/i.test(part));
}
export function partialTemuReadProof(order,observation){
 if(observation.reference!==(order.source_reference||order.reference)||!observation.coverage?.detail||!observation.coverage?.version||!observation.coverage?.consistency||!Number.isSafeInteger(observation.sourceVersion)||observation.sourceVersion<=0||observation.payload?.detail?.parentOrderMap?.parentOrderSn!==observation.reference||!observation.errors?.length||observation.errors.some(e=>!['shipping','amounts','shipments','packages'].includes(e.field)))return null;
 const previous=Math.max(Number(order.source_payload?.temuOrderDetail?.parentOrderMap?.updateTime)||0,Number(order.source_payload?.temuReceiptObservation?.payload?.detail?.parentOrderMap?.updateTime)||0,Number(order.source_payload?.temuCatchupPartial?.sourceVersion)||0,Number(order.source_payload?.temuSourceRead?.sourceVersion)||0);
 if(observation.sourceVersion<previous)return null;
 const reason=observation.errors.some(e=>String(e.code)==='3000032'&&e.field==='amounts')?'TEMU · Autorisation API des montants manquante (3000032) · Boutique à réautoriser':observation.errors.map(e=>'TEMU · '+e.field+' : '+e.code).join(' ; ');
 return {checkedAt:observation.checkedAt,sourceVersion:observation.sourceVersion,coverage:observation.coverage,errors:observation.errors,sourceStage:observation.sourceStage,currentReason:reason,externalWrites:0};
}
