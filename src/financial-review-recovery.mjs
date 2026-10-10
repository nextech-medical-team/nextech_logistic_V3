import {temuSellerTotals} from './temu-commercial-source.mjs';
import {resumeFinancialInitialHolds} from './financial-initial-hold.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
import {bcAllowedSql} from './bc-authorization.mjs';
import {temuPricingIssue} from './temu-bc-pricing.mjs';
import {temuCommercialSource} from './temu-commercial-source.mjs';
import {temuCountryAmounts} from './temu-country-vat.mjs';
import {acceptedMonetaryDifference} from './bc-pricing.mjs';
import {assertWholeTemuPackage} from './temu-label-pdf.mjs';
export async function financialPackageSafe(db,o,lines){
 const jobs=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows;
 for(const t of jobs){
  if(!t.attempt_id&&!t.packages?.length)continue;
  if(t.status!=='complete'||t.packages?.length!==1)return false;
  try{assertWholeTemuPackage(o,lines,t.result,t.packages[0]);}catch{return false;}
  if(!(await db.query('SELECT 1 FROM temu_label_documents WHERE reference=$1 AND package=$2',[o.reference,t.packages[0]])).rows.length)return false;
 }
 return true;
}
export const recoveryPolicy='financial-recovery-unified-tolerance-20261007-v2';
export function safeFinancialRecovery(o){
 return o.archived===false&&!o.partial_mode&&!o.resolution_pending_resume&&!cancellationBlock(o)&&!String(o.reference||'').startsWith('DEMO-')
 && !Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')

 && !/commande annulée/i.test(o.issue||'')&&!['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)
 && o.label_status!=='cancelled'&&!/^creating|^publishing/.test(o.erp_live?.phase||'')
 && !o.erp_live?.bl?.id&&!o.erp_live?.stockDocument?.id;
}
export function sourceTemuTotals(o){return temuSellerTotals(o);}
export async function resumeTemuFinancialReviews(db){
 await resumeFinancialInitialHolds(db);
 // Continuously scan causes, not a frozen reference list. No external mutation here.
 const rows=(await db.query(`SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
 WHERE e.status='review' AND o.channel IN ('temu','amazon') AND (${bcAllowedSql}) AND NOT o.partial_mode AND NOT o.resolution_pending_resume
 AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit') AND coalesce(o.label_status,'')<>'cancelled'

 AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
 AND o.erp_live->'bc'->>'id' IS NULL AND coalesce(o.erp_live->>'phase','')=''
 AND ((o.channel='temu' AND (e.error LIKE 'TEMU · Remises client et TVA à rapprocher%' OR e.error LIKE 'TEMU · Nombre de lignes financières%' OR e.error LIKE 'TEMU · Annulation partielle%'
 OR e.error LIKE 'TEMU · Totaux client source incohérents%' OR e.error LIKE 'TEMU · Prix client et TVA source incohérents%')) OR (o.channel='amazon' AND e.error='BC · Taux de TVA source à préciser' AND coalesce(o.erp_live->'financialRecovery'->>'policy','')<>'financial-recovery-unified-tolerance-20261007-v2'))
 AND coalesce((o.erp_live->'financialRecovery'->>'checkedAt')::timestamptz,'epoch')<now()-interval '2 minutes'
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND (c.result IS NOT NULL OR jsonb_array_length(c.tracking)>0 OR c.status IN ('creating','ready','awaiting_pdf')))
 ORDER BY e.updated_at LIMIT 10`)).rows;
 for(const o of rows){
  if(!safeFinancialRecovery(o))continue;
  const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
  if(!await financialPackageSafe(db,o,lines))continue;
  // Amazon is rechecked once by the normal worker before any BC creation.
  const issue=o.channel==='temu'?temuPricingIssue(o,lines):null;
  await db.transaction(async tx=>{
   const now=(await tx.query(`SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.id=$1 AND e.status='review' FOR UPDATE OF o,e`,[o.id])).rows[0];
   if(!now||!safeFinancialRecovery(now)||now.error!==o.error||JSON.stringify(now.source_payload)!==JSON.stringify(o.source_payload)||JSON.stringify(now.erp_live)!==JSON.stringify(o.erp_live))return;
   const latest=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line FOR UPDATE',[o.id])).rows;
   if(JSON.stringify(latest)!==JSON.stringify(lines))return;
   if(!await financialPackageSafe(tx,now,latest))return;
   if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[o.id])).rows.length)return;
   const trace={policy:recoveryPolicy,checkedAt:new Date().toISOString(),status:issue?'blocked':'accepted',issue};
   await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify({...now.erp_live,financialRecovery:trace})]);
   if(issue&&issue!==now.error)await tx.query('UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1',[o.id,issue]);
   if(!issue){await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','financial_review.reconciled',$1)",[JSON.stringify({orderId:o.id,policy:recoveryPolicy})]);}
  });
 }
}
export function resolvedMonetaryPreview(r,o){
 if(r.status!=='review'||r.action!=='equivalent-preview'||!/^BC · (Total Erplain|TVA Erplain)/.test(r.error||''))return false;
 const p=o.erp_live?.pricing,c=p?.confirmed;
 if(!c||p.status!=='verified'||!(Date.parse(p.verifiedAt)>Date.parse(r.updated_at)))return false;
 return acceptedMonetaryDifference(c.total,p.total,p)&&acceptedMonetaryDifference(c.tax,p.tax,p);
}
export async function reconcileMonetaryPreviews(db){
 // Re-run the read-only preview; do not silently apply an unconfirmed equivalent.
 await db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT r.*,to_jsonb(o) AS "order" FROM resolution_jobs r JOIN orders o ON o.id=r.order_id
  WHERE r.status='review' AND r.action='equivalent-preview' AND (r.error LIKE 'BC · %Erplain%' OR r.error LIKE 'Taxes différentes%')
  AND (${bcAllowedSql}) AND NOT o.partial_mode
  AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
  AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing')
  ORDER BY r.updated_at LIMIT 20 FOR UPDATE OF r,o SKIP LOCKED`)).rows;
  const used=new Set();for(const r of rows){if(used.has(r.order_id))continue;
   // Only a newer verified monetary proof permits one read-only recheck.
   // Old matching totals cannot revive the same failed preview forever.
   // Tax-code mismatches require their own explicit reconciliation, not monetary metadata.
   if(!resolvedMonetaryPreview(r,r.order))continue;
   used.add(r.order_id);await tx.query("UPDATE resolution_jobs SET status='queued',error=null,stage='Recontrôle de l’équivalent après correction des montants',updated_at=now(),result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND status='review'",[r.id,JSON.stringify({previousDiagnostic:r.error,recoveryPolicy})]);
  }
 });
}
