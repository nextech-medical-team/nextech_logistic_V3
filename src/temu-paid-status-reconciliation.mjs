// Reconcile only the local label state from completed existing proofs. No external writes.
export const paidStatusCandidatesSql=`SELECT o.id,o.reference,o.label_status AS previous_status FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id JOIN temu_label_jobs j ON j.reference=o.reference
 WHERE o.channel='temu' AND NOT o.archived AND NOT coalesce(o.partial_mode,false) AND o.transport_choice IS NULL AND o.label_status='blocked' AND coalesce(o.issue,'')='' AND NOT coalesce(o.resolution_pending_resume,false)
 AND o.erp_live->>'phase'='bl_ready' AND o.erp_live->'bc'->>'id' IS NOT NULL AND o.erp_live->'bc'->>'status'='active' AND o.erp_live->'bl'->>'id' IS NOT NULL AND o.erp_live->'bl'->>'status'='ready_to_ship'
 AND o.erp_live->'stockDocument'->>'status'='completed' AND o.erp_live->'stockDocument'->>'update_stock'='true' AND e.status='complete' AND e.error IS NULL
 AND o.source_payload->'temuDirect'->>'state'='verified' AND NOT coalesce(o.source_payload ? 'marketplacePendingCorrection',false) AND coalesce(o.source_payload->>'visibilityHold','false')<>'true'
 AND j.status='complete' AND j.error IS NULL AND j.result->>'source'='temu_direct' AND jsonb_typeof(j.packages)='array' AND jsonb_array_length(j.packages)>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(j.packages) p(package) WHERE NOT EXISTS(SELECT 1 FROM temu_label_documents d WHERE d.reference=o.reference AND d.package=p.package AND octet_length(d.pdf)>0))
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting','review'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
 AND NOT EXISTS(SELECT 1 FROM lines l LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) WHERE l.order_id=o.id AND coalesce(c.message,'')<>'' AND l.source_payload->>'erplainCorrectedWeightKg' IS NULL)
 ORDER BY o.id LIMIT 200`;
export async function reconcilePaidTemuStatuses(db){return db.transaction(async tx=>{
 const rows=(await tx.query(paidStatusCandidatesSql+' FOR UPDATE OF o,e,j SKIP LOCKED')).rows;
 for(const o of rows){await tx.query("UPDATE orders SET label_status='ready' WHERE id=$1",[o.id]);await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.paid_label_status_reconciled',$1)",[JSON.stringify({orderId:o.id,previous:o.previous_status,next:'ready',proof:'bc_bl_stock_completed_and_all_existing_temu_pdfs',externalWrites:0})]);}
 return rows.length;
});}
