import {createHash} from 'node:crypto';
const checkpoints=new Set(['queued','draft_confirmed','lines_confirmed','bl_confirmed']);
export function ownsPartialPreparation(d){return ['erplain_wait','draft_confirmed','lines_confirmed','bl_confirmed','temu_wait','temu_confirm','temu_ready_review'].includes(d.status);}
function identity(d){const selection=d.selection.map(l=>({lineId:String(l.lineId),variantId:String(l.variantId),locationId:String(l.locationId),quantity:Number(l.quantity),price:Number(l.price)})).sort((a,b)=>a.lineId.localeCompare(b.lineId));return createHash('sha256').update(JSON.stringify({id:d.id,orderId:d.order_id,requestId:d.request_id,selection,blId:d.bl?.id||null,stock:d.stock_document||null,labelChoice:d.label_choice})).digest('hex');}
export function assertPartialRetryIdentity(d){if(!checkpoints.has(d.erplain_retry?.checkpoint)||d.erplain_retry.identity!==identity(d))throw Error('Préparation modifiée pendant l’attente Erplain : rapprochement requis');}
export function partialRetryPlan(error,d,checkpoint,now=Date.now()){
 if(!checkpoints.has(checkpoint)||Number(error.httpStatus)!==429||!(error.erplainReadOnly===true||error.erplainRequestNotSent===true||error.confirmedRateLimitRejection===true))return null;
 if(checkpoint==='queued'&&d.bl?.id||checkpoint!=='queued'&&!d.bl?.id||d.stock_document||d.carrier_result||d.tracking?.length)return null;
 const attempts=(Number(d.erplain_retry?.attempts)||0)+1;
 const providerDelay=Number(error.retryAfter);
 const delay=Math.max(60,Math.min(900,60*2**Math.min(attempts-1,4)),Number.isFinite(providerDelay)?providerDelay:0);
 return {checkpoint,bcId:d.retryBcId||null,identity:identity(d),attempts,nextAt:new Date(now+delay*1000).toISOString(),proof:error.erplainReadOnly===true?'read_only':error.erplainRequestNotSent===true?'not_sent':'confirmed_rate_limit_rejection'};
}
