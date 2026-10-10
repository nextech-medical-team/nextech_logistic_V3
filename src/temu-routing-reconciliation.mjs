// Local routing only. No provider call, label operation, stock or ERP change.
export const temuRoutingCandidates=`SELECT o.* FROM orders o
 WHERE o.channel='temu' AND coalesce(o.carrier,'')<>'temu' AND o.transport_choice IS NULL
 AND NOT o.archived AND NOT o.partial_mode
 AND coalesce(o.label_status,'')<>'cancelled'
 AND coalesce(o.erp_live->'bc'->>'status','')<>'cancelled' AND coalesce(o.erp_live->>'phase','') !~ '^(creating|publishing)'
 AND coalesce(o.issue,'') !~* 'commande annulée'
 AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated')
 AND coalesce(o.suspension->>'active','false')<>'true' AND NOT coalesce(o.suspension ? 'erplainCancellation',false)
 AND coalesce(o.source_payload->>'cancelled','false') NOT IN ('true','1') AND coalesce(o.source_payload->>'cancelled_at','')=''
 AND NOT coalesce(o.source_payload ? 'marketplacePendingCorrection',false)
 AND coalesce(o.source_payload->'temuOrderDetail'->'parentOrderMap'->>'parentOrderStatus','')<>'3'
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND (c.status NOT IN ('failed','superseded') OR c.result IS NOT NULL OR jsonb_array_length(coalesce(c.tracking,'[]'))>0))
 AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM carrier_label_history h WHERE h.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM extra_parcels p WHERE p.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing')
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','applying','checking','waiting'))
 AND NOT EXISTS(SELECT 1 FROM temu_label_jobs t WHERE t.reference=o.reference AND t.status IN ('purchasing','uncertain','cancelled','cancellation_requested','not_to_ship'))
 ORDER BY o.id LIMIT 100`;
export async function reconcileTemuRouting(db,{apply=false,backup}={}){
 if(!apply)return {candidates:(await db.query(temuRoutingCandidates)).rows.length,applied:0};
 if(typeof backup!=='function')throw Error('Sauvegarde requise avant correction du routage TEMU');
 return db.transaction(async tx=>{
  const rows=(await tx.query(temuRoutingCandidates+' FOR UPDATE OF o SKIP LOCKED')).rows;
  if(!rows.length)return {candidates:0,applied:0};
  await backup(rows);
  const ids=rows.map(o=>o.id);
  await tx.query("UPDATE orders SET carrier='temu',transport_choice=null WHERE id=ANY($1::text[])",[ids]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.routing_reconciled',$1)",[JSON.stringify({orderIds:ids,count:ids.length,externalWrites:0,labelsPreserved:true})]);
  return {candidates:rows.length,applied:rows.length};
 });
}
