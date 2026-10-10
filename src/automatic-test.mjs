import {retireTestCarrierJobs} from './retire-test-carriers.mjs';
import {randomUUID} from 'node:crypto';
import {bcAllowedSql} from './bc-authorization.mjs';
import {validatedDeliverySql} from './label-stock-gate.mjs';
export async function reconcileAutomaticTest(db){
 const enabled=(await db.query("SELECT value FROM settings WHERE key='automatic_live'")).rows[0]?.value?.enabled;
 if(!enabled)return;
 await retireTestCarrierJobs(db);
 await resumeSynchronizedGofo(db);
 await db.query(`INSERT INTO erp_live_jobs(order_id) SELECT o.id FROM orders o WHERE (${bcAllowedSql}) AND (o.erp_live->'bc'->>'id' IS NULL OR (o.resolution_pending_resume=false AND o.partial_mode=false)) ON CONFLICT DO NOTHING`);
 await db.query(`WITH retry AS (UPDATE erp_live_jobs e SET status='pending',error=null,updated_at=now() FROM orders o WHERE e.order_id=o.id AND e.status='review' AND (${bcAllowedSql}) AND o.erp_live->'bc'->>'id' IS NULL AND coalesce(o.erp_live->>'bcAuditVersion','')<>'separation-v1' AND e.error ~* '(interrompu|incertain|informations transport manquantes|création à vérifier)' RETURNING e.order_id) UPDATE orders SET erp_live=erp_live||'{"bcAuditVersion":"separation-v1"}'::jsonb WHERE id IN (SELECT order_id FROM retry)`);
 // Labels follow verified stock, quantities and BL.
 await db.query(`INSERT INTO carrier_jobs(order_id,carrier,environment)
 SELECT id,CASE WHEN carrier LIKE 'gls%' THEN 'gls' ELSE carrier END,'production' FROM orders
 WHERE resolution_pending_resume=false AND partial_mode=false AND reference NOT LIKE 'DEMO-%' AND (${validatedDeliverySql})
 AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=orders.id AND c.status IN ('queued','applying','checking','waiting')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status IN ('queued','running','waiting')) AND label_status='simulated' AND weight_kg>0 AND carrier IN ('gls','gls_pharma','gofo')
 ON CONFLICT DO NOTHING`);
}

// A read-only Erplain synchronization holds preparation. Resume through the
// normal resolution workflow, never by bypassing its stock/fingerprint gate.
export async function resumeSynchronizedGofo(db){
 return db.transaction(async tx=>{
  const candidates=(await tx.query(`SELECT o.id,r.id sync_id FROM orders o
   JOIN LATERAL(SELECT * FROM resolution_jobs WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
   WHERE (coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation') AND NOT (o.suspension ? 'suspendedAt' AND o.resolution_pending_resume) AND NOT o.archived AND o.reference NOT LIKE 'DEMO-%' AND NOT coalesce(o.source_payload ? 'marketplacePendingCorrection',false) AND NOT coalesce((o.source_payload->>'cancelled')='true',false) AND coalesce(o.source_payload->>'cancelled_at','')='' AND NOT coalesce(o.issue,'') ~* 'commande annulée') AND o.carrier='gofo' AND o.channel<>'temu' AND coalesce(o.source_payload->>'erplainImported','false')<>'true'
   AND o.resolution_pending_resume=true AND o.partial_mode=false AND o.label_status='simulated'
   AND coalesce(o.tracking_status,'') NOT IN ('shipped','in_transit','delivered','delivered_simulated','cancelled')
   AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed','completed')
   AND coalesce(o.issue,'')='' AND coalesce(o.erplain_refresh->'issues','[]'::jsonb)='[]'::jsonb
   AND r.action='sync' AND r.status='complete' AND r.result->>'preparationNotStarted'='true' AND coalesce(r.error,'')=''
   AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='complete')
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
   ORDER BY o.processing_priority_at ASC NULLS LAST,o.id LIMIT 25 FOR UPDATE OF o SKIP LOCKED`)).rows;
  const queued=[];
  for(const o of candidates){
   const id=randomUUID(),requestId='automatic-gofo-sync-'+o.sync_id;
   const added=(await tx.query(`INSERT INTO resolution_jobs(id,order_id,request_id,action,status,stage,payload)
    VALUES($1,$2,$3,'resume','queued','Reprise automatique après synchronisation Erplain',$4)
    ON CONFLICT DO NOTHING RETURNING id`,[id,o.id,requestId,JSON.stringify({id:o.id,requestId,action:'resume',type:'resolved'})])).rows;
   if(!added.length)continue;
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','resolution.automatic_gofo_resume',$1)",[JSON.stringify({orderId:o.id,resolutionId:id,synchronizationResolutionId:o.sync_id})]);queued.push(o.id);
  }
  return queued;
 });
}
