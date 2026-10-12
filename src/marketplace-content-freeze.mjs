// Human decision 2026-10-11: a completed marketplace BC freezes order content.
export const frozenMarketplaceChannels=new Set(['temu','amazon','shopify']);
const validId=id=>['string','number'].includes(typeof id)&&String(id).trim()!==''&&String(id)!=='0';
export function marketplaceContentFrozen(order){return frozenMarketplaceChannels.has(order?.channel)&&(validId(order.erp_live?.bc?.id)||order.source_payload?.postBcContentFreeze?.enabled===true);}
export function marketplaceContentFrozenSql(alias=''){const p=alias?alias+'.':'';return `(${p}channel IN ('temu','amazon','shopify') AND (coalesce(nullif(${p}erp_live->'bc'->>'id',''),'0')<>'0' OR ${p}source_payload->'postBcContentFreeze'->>'enabled'='true'))`;}
export const retiredSourceReviewPattern='^(TEMU · Données source différentes : .+ · Rapprochement à vérifier|Commande modifiée (dans|sur) (la plateforme|temu|amazon|shopify).*|Modification source (TEMU|AMAZON|SHOPIFY) · .+ à vérifier|Commande source modifiée : rapprochement des données en attente)$';
const retired=new RegExp(retiredSourceReviewPattern,'i');
export function retireSourceReviewReason(order,reason){if(!marketplaceContentFrozen(order)||typeof reason!=='string')return reason;return reason.split(/\s;\s/).filter(part=>!retired.test(part.trim())).join(' ; ')||null;}
export function sourceReviewReasonSql(raw,alias=''){return `CASE WHEN ${marketplaceContentFrozenSql(alias)} THEN (SELECT nullif(string_agg(part,' ; ' ORDER BY position),'') FROM regexp_split_to_table((${raw}), '[[:space:]];[[:space:]]') WITH ORDINALITY AS review(part,position) WHERE btrim(part) !~* '${retiredSourceReviewPattern}') ELSE (${raw}) END`;}
export function projectFrozenSourceDiagnostics(order){if(!marketplaceContentFrozen(order))return order;for(const [target,key] of [[order,'issue'],[order,'resolution_error'],[order.erp_live_job,'error'],[order.carrier_job,'error'],[order.temu_job,'error'],[order,'carrier_error'],[order.monitoring,'result'],[order.monitoring,'externalReadIssue'],[order.monitoring,'externalResult'],...(order.resolution_actions||[]).map(j=>[j,'error'])])if(target)target[key]=retireSourceReviewReason(order,target[key]);return order;}
export function lifecycleObservation(channel,payload,{reference,checkedAt=new Date().toISOString()}={}){
 if(!frozenMarketplaceChannels.has(channel))throw Error('Plateforme non prise en charge');
 let status=null,cancelled=null,refundStatus='unknown',refundAmount=null,currency=null,version=null;
 if(channel==='temu'){
  const p=payload?.detail?.parentOrderMap||payload?.parentOrderMap;
  if(p?.parentOrderSn!==reference)throw Error('TEMU · Identité de statut non vérifiable');
  status=Number(p.parentOrderStatus);if(!Number.isSafeInteger(status)||status<1||status>7)throw Error('TEMU · Statut non vérifiable');cancelled=status===3;version=Number.isSafeInteger(Number(p.updateTime))&&Number(p.updateTime)>0?Number(p.updateTime):null;
  const a=payload?.amounts?.parentOrderMap;
  if(a){if(a.parentOrderSn!==reference)throw Error('TEMU · Identité du remboursement non vérifiable');const r=a.refundsTotal,paid=a.customerPaid;currency=r?.currency||null;if(r&&Number.isSafeInteger(Number(r.amount))&&Number(r.amount)>=0&&/^[A-Z]{3}$/.test(currency||'')){refundAmount=Number(r.amount);refundStatus=refundAmount===0?'none':paid?.currency===currency&&Number.isSafeInteger(Number(paid.amount))&&Number(paid.amount)>0&&refundAmount>=Number(paid.amount)?'full':'partial';}}
 }else if(channel==='shopify'){
  if(payload?.name!==reference||!/^\d+$/.test(String(payload.id||'')))throw Error('Shopify · Identité de statut non vérifiable');
  status=payload.fulfillment_status||null;cancelled=!!payload.cancelled_at;version=payload.updated_at||null;
  const financial=String(payload.financial_status||'').toLowerCase();refundStatus=financial==='refunded'?'full':financial==='partially_refunded'?'partial':['paid','pending','authorized','partially_paid','voided'].includes(financial)?'none':'unknown';
 }else{
  const ref=payload?.AmazonOrderId||payload?.orderid||payload?.reference;
  if(ref!==reference)throw Error('Amazon · Identité de statut non vérifiable');
  status=payload.OrderStatus||payload.orderstatus||payload['order-status']||null;cancelled=status===null?null:/^cancel(?:led|ed)$/i.test(status);version=payload.LastUpdateDate||payload.updated_at||null;
  const financial=String(payload.RefundStatus||payload.refundstatus||'').toLowerCase();refundStatus=['refunded','full'].includes(financial)?'full':['partial','partially_refunded'].includes(financial)?'partial':financial==='none'?'none':'unknown';
 }
 return {channel,reference,checkedAt,status,cancelled,refundStatus,refundAmount,currency,version,scope:'cancellation-refund-only',indicative:true,contentFrozen:true};
}
export async function retirePostBcSourceReview(tx,order,{checkedAt=new Date().toISOString()}={}){
 if(!marketplaceContentFrozen(order))return false;
 const s=structuredClone(order.source_payload||{}),pending=s.marketplacePendingCorrection,issue=retireSourceReviewReason(order,order.issue),prior=s.postBcContentFreeze||{};
 const changed=pending!==undefined||s.platformModificationFields!==undefined||issue!==order.issue||prior.enabled!==true;
 if(!changed)return false;
 s.postBcContentFreeze={...prior,enabled:true,bcId:prior.bcId||order.erp_live?.bc?.id||null,since:prior.since||checkedAt,policy:'cancellation-refund-only',...(pending!==undefined?{retiredReview:{at:checkedAt,payload:pending,fields:s.platformModificationFields||null,issue:order.issue}}:{})};
 delete s.marketplacePendingCorrection;delete s.platformModificationFields;
 if(s.temuCatchup?.conflicts?.length)s.temuCatchup={...s.temuCatchup,retiredContentConflicts:s.temuCatchup.conflicts,conflicts:[]};
 await tx.query('UPDATE orders SET source_payload=$2::jsonb,issue=$3 WHERE id=$1',[order.id,JSON.stringify(s),issue]);
 Object.assign(order,{source_payload:s,issue});return true;
}
export async function recordPostBcLifecycle(tx,order,observation){
 if(!marketplaceContentFrozen(order)||observation.reference!==(order.source_reference||order.reference)||observation.channel!==order.channel||observation.scope!=='cancellation-refund-only')throw Error('Observation de cycle de vie non identifiable');
 const old=order.source_payload?.platformLifecycleObservation,oldAt=Date.parse(old?.checkedAt),at=Date.parse(observation.checkedAt);if(!Number.isFinite(at)||Number.isFinite(oldAt)&&at<oldAt)throw Error('Observation de cycle de vie antérieure');
 if(old?.version!=null&&observation.version!=null){const a=typeof old.version==='number'?old.version:Date.parse(old.version),b=typeof observation.version==='number'?observation.version:Date.parse(observation.version);if(Number.isFinite(a)&&Number.isFinite(b)&&b<a)throw Error('Version de cycle de vie antérieure');}
 await retirePostBcSourceReview(tx,order,{checkedAt:observation.checkedAt});
 const minimal=Object.fromEntries(['channel','reference','checkedAt','status','cancelled','refundStatus','refundAmount','currency','version','scope','indicative','contentFrozen'].map(k=>[k,observation[k]]));
 await tx.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[order.id,JSON.stringify({platformLifecycleObservation:minimal,platformLifecycleError:observation.errors?.length?{at:observation.checkedAt,message:observation.errors.map(e=>e.message).join(' ; ')}:null})]);
 return {contentFrozen:true,conflicts:[],scope:'cancellation-refund-only'};
}
export async function retirePostBcSourceReviews(db,{limit=100}={}){return db.transaction(async tx=>{const rows=(await tx.query(`SELECT * FROM orders o WHERE ${marketplaceContentFrozenSql('o')} AND (o.source_payload ? 'marketplacePendingCorrection' OR o.source_payload ? 'platformModificationFields' OR ${sourceReviewReasonSql('o.issue','o')} IS DISTINCT FROM o.issue) ORDER BY CASE WHEN o.source_payload ? 'marketplacePendingCorrection' OR o.source_payload ? 'platformModificationFields' OR coalesce(o.issue,'')<>'' THEN 0 ELSE 1 END,o.id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit])).rows;for(const o of rows)await retirePostBcSourceReview(tx,o);return {checked:rows.length,externalWrites:0,documentsChanged:0};});}
