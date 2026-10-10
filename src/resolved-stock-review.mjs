import {bcAllowedSql} from './bc-authorization.mjs';
export function resolvedStockReview(x){
 const o=x.order||{},s=o.erp_live||{};
 return x.status==='review'&&x.stage==='Erplain à compléter'
 && /^(?:Stock Erplain · Mouvement à vérifier :|Stock Erplain : ancien cycle non identifié|BL bloqué.*stock insuffisant)/.test(x.error||'')
 && o.archived===false&&!o.partial_mode&&!o.resolution_pending_resume
 && !String(o.reference||'').startsWith('DEMO-')&&!/commande annulée/i.test(o.issue||'')
 && !Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')
 && ![true,'true',1,'1'].includes(o.source_payload?.cancelled)&&!o.source_payload?.cancelled_at
 && o.label_status!=='cancelled'&&!['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)
 && s.bc?.id&&s.bc.status==='active'&&s.bl?.id&&!['cancelled','closed'].includes(s.bl.status)
 && s.phase==='bl_created'&&s.stockDocument?.id&&s.stockDocument.status==='completed'&&s.stockDocument.update_stock===true
 && Date.parse(s.verifiedAt)>Math.max(Date.parse(x.created_at),Date.parse(x.updated_at||x.created_at))
 && x.erp_status==='complete'&&!x.erp_error&&x.carrier_status==='ready'&&!x.carrier_error&&Number(x.documents)>0;
}
export async function reconcileResolvedStockReviews(db){
 // No external calls: row locks on correction/order/ERP/carrier protect the local reconciliation.
 return db.transaction(async tx=>{
 const rows=(await tx.query(`SELECT r.id,r.status,r.stage,r.error,r.created_at,r.updated_at,to_jsonb(o) AS "order",e.status erp_status,e.error erp_error,c.status carrier_status,c.error carrier_error,
 (SELECT count(*)::int FROM carrier_documents d WHERE d.order_id=o.id) documents
 FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id JOIN carrier_jobs c ON c.order_id=o.id
 WHERE r.status='review' AND r.stage='Erplain à compléter' AND (r.error LIKE 'Stock Erplain · Mouvement à vérifier :%' OR r.error LIKE 'Stock Erplain : ancien cycle non identifié%' OR r.error LIKE 'BL bloqué%stock insuffisant%')
 AND (${bcAllowedSql}) AND coalesce(o.source_payload->>'cancelled','')<>'1' AND coalesce(o.label_status,'')<>'cancelled' AND NOT o.partial_mode AND NOT o.resolution_pending_resume
 AND e.status='complete' AND e.error IS NULL AND c.status='ready' AND c.error IS NULL
 AND o.erp_live->>'phase'='bl_created' AND o.erp_live->'stockDocument'->>'status'='completed'
 AND o.erp_live->'stockDocument'->>'update_stock'='true'
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
 ORDER BY r.created_at LIMIT 20 FOR UPDATE OF r,o,e,c SKIP LOCKED`)).rows;
 let n=0;for(const x of rows){if(!resolvedStockReview(x))continue;
 await tx.query(`UPDATE resolution_jobs SET status='complete',stage='Diagnostic résolu · documents et étiquette vérifiés',error=null,result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1 AND status='review'`,[x.id,JSON.stringify({resolvedPreviousError:x.error,reconciledAt:new Date().toISOString()})]);n++;
 }return n;
 });
}
