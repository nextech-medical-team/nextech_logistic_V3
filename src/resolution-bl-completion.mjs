// Local reconciliation only: never invokes Erplain or a carrier.
export async function reconcileCompletedBlResumptions(db) {
 return db.query(`UPDATE resolution_jobs r
 SET status='complete',stage='Terminé',error=null,
 result=coalesce(r.result,'{}'::jsonb)||jsonb_build_object('message','BL prêt à livrer. Étiquette existante conservée.'),updated_at=now()
 FROM orders o,erp_live_jobs e,carrier_jobs c
 WHERE r.order_id=o.id AND e.order_id=o.id AND c.order_id=o.id
 AND r.status='waiting' AND r.action='resume-erp'
 AND r.result->>'resume'='true'
 AND coalesce(r.result->>'regenerateExisting','false')='false'
 AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
 AND e.status='complete' AND e.error IS NULL AND e.updated_at>=r.created_at
 AND o.erp_live->>'phase'='bl_ready'
 AND o.erp_live->'bc'->>'status'='active'
 AND o.erp_live->'bl'->>'id' IS NOT NULL
 AND o.erp_live->'bl'->>'status' IN ('ready_to_ship','shipped','delivered','completed')
 AND o.erp_live->>'verifiedAt' IS NOT NULL AND o.erp_live->>'stockCheckedAt' IS NOT NULL
 AND c.status='ready' AND c.error IS NULL
 AND EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
 RETURNING r.id`);
}
