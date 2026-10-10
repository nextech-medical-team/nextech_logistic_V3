import {mutationBlock,transientErpError} from './erp-transient-policy.mjs';
import {canRetryStock} from './stock-creation-claim.mjs';

export function stockCheckDue(o,now=Date.now()){
 if(mutationBlock(o)||!canRetryStock(o)||Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection'))return false;
 const s=o.erp_live,r=s.stockReconciliation||{};
 if(r.state==='blocked')return false;
 const next=Date.parse(r.nextCheckAt);if(r.nextCheckAt&&(!Number.isFinite(next)||next>now))return false;
 return ['waiting_api','waiting_missing','queued'].includes(r.state)||s.stockCreationOutcome?.kind==='rejected_rate_limit'||transientErpError(o.error||s.stockLastFailure?.message);
}
export async function scheduleStockChecks(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
   AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit') AND coalesce(o.label_status,'')<>'cancelled'
   AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed') AND coalesce(o.erp_live->'bl'->>'status','') NOT IN ('cancelled','closed')
   AND NOT (coalesce(o.source_payload,'{}') ? 'marketplacePendingCorrection')
   AND coalesce(o.source_payload->>'cancelled','') NOT IN ('true','1') AND coalesce(o.source_payload->>'cancelled_at','')=''
   AND NOT (o.channel='shopify' AND (coalesce(o.source_payload->>'cancelledAt','')<>'' OR lower(coalesce(o.source_payload->>'financial_status',o.source_payload->>'displayFinancialStatus',''))='refunded'))
   AND coalesce(o.source_payload->'temuOrderDetail'->'parentOrderMap'->>'parentOrderStatus','')<>'3'
   AND NOT jsonb_path_exists(coalesce(o.source_payload,'{}'),'$.temuOrderDetail.parentOrderMap.parentOrderLabel[*] ? (@.name == "pending_buyer_cancellation" && (@.value == 1 || @.value == "1"))')
   AND NOT coalesce(o.issue,'') ~* 'commande annulée'
   AND coalesce(e.error,'') NOT LIKE 'BC%' AND coalesce(e.error,'') NOT LIKE 'Stock Erplain · Mouvement à vérifier : BC%'
   AND coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation')
   AND o.erp_live->>'phase'='creating_stock' AND (o.erp_live->'stockDocument' IS NULL OR o.erp_live->'stockDocument'='null'::jsonb)
   AND o.erp_live->'bc'->>'id' IS NOT NULL AND o.erp_live->'bl'->>'id' IS NOT NULL
   AND coalesce(o.erp_live->'stockReconciliation'->>'state','')<>'blocked'
   AND (o.erp_live->'stockReconciliation'->>'nextCheckAt' IS NULL OR o.erp_live->'stockReconciliation'->>'nextCheckAt'<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND (e.error ~* 'Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError|deadlock|SQLSTATE.40001.|lock wait timeout' OR o.erp_live->'stockReconciliation'->>'state' IN ('waiting_api','waiting_missing','queued') OR o.erp_live->'stockCreationOutcome'->>'kind'='rejected_rate_limit')
   AND e.updated_at<now()-interval '15 seconds'
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
   ORDER BY e.updated_at FOR UPDATE OF o,e SKIP LOCKED LIMIT 10`)).rows;
  let n=0;
  for(const o of rows){if(!stockCheckDue(o))continue;
   const r={...o.erp_live.stockReconciliation,state:'queued',checks:Math.max(0,Number(o.erp_live.stockReconciliation?.checks)||0)+1,queuedAt:new Date().toISOString()};
   await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{stockReconciliation}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(r)]);
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);n++;
  }return n;
 });
}
export function stockNotFound(){const e=Error('Stock Erplain · Mouvement non retrouvé : rapprochement automatique en attente, aucune seconde déduction');e.code='STOCK_NOT_FOUND_AFTER_ATTEMPT';return e;}
export async function stockCheckFailure(db,o,error,message,now=Date.now()){
 if(o.erp_live?.phase!=='creating_stock')return message;
 const old=o.erp_live.stockReconciliation||{},waiting=error.code==='STOCK_NOT_FOUND_AFTER_ATTEMPT'?'waiting_missing':transientErpError(message)?'waiting_api':'blocked';
 const checks=Math.max(1,Number(old.checks)||1),delay=Math.max(Number(error.retryAfter||0)*1000,Math.min(900000,60000*2**Math.min(checks-1,4)));
 const r={...old,state:waiting,lastError:message,lastCheckAt:new Date(now).toISOString(),...(waiting==='blocked'?{nextCheckAt:null}:{nextCheckAt:new Date(now+delay).toISOString()})};
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{stockReconciliation}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(r)]);o.erp_live.stockReconciliation=r;
 const displayed=waiting==='waiting_api'?'Stock Erplain · API temporairement indisponible : vérification automatique programmée':message;
 if(waiting!=='blocked')await db.query(`UPDATE resolution_jobs SET result=coalesce(result,'{}'::jsonb)||jsonb_build_object('automaticStockReconciliation',true,'previousStockError',coalesce(result->>'previousStockError',error),'stockLastCheckAt',$3::text),error=$2,updated_at=now() WHERE order_id=$1 AND status='review' AND stage='Erplain à compléter' AND (error LIKE 'Stock Erplain%' OR result->>'automaticStockReconciliation'='true')`,[o.id,displayed,r.lastCheckAt]);
 return displayed;
}
export function stockCheckConfirmed(o){o.erp_live.stockReconciliation={...o.erp_live.stockReconciliation,state:'verified',nextCheckAt:null,verifiedAt:new Date().toISOString()};}
export async function closeStockChecks(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT r.id,r.error,r.updated_at,to_jsonb(o) AS "order" FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE r.status='review' AND r.stage='Erplain à compléter' AND (r.result->>'automaticStockReconciliation'='true' OR r.error='Stock Erplain · API temporairement indisponible : vérification automatique programmée') AND e.status='complete' AND e.error IS NULL AND o.erp_live->'stockReconciliation'->>'state'='verified'
   ORDER BY r.updated_at FOR UPDATE OF r,o,e SKIP LOCKED LIMIT 100`)).rows;
  let closed=0;for(const r of rows){const o=r.order,s=o.erp_live||{};
   if(mutationBlock(o)||o.partial_mode||Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')||!s.bc?.id||s.bc.status!=='active'||!s.bl?.id||!['ready_to_ship','make_the_shipment'].includes(s.bl.status)||s.phase!=='bl_ready'||!s.stockDocument?.id||s.stockDocument.status!=='completed'||s.stockDocument.update_stock!==true||!(new Date(s.verifiedAt).getTime()>new Date(r.updated_at).getTime()))continue;
   await tx.query("UPDATE resolution_jobs SET status='complete',error=null,stage='Mouvement de stock vérifié automatiquement',result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify({stockDocument:s.stockDocument,stockVerifiedAt:s.verifiedAt,resolvedStockError:r.error})]);closed++;
  }return closed;
 });
}
