import {chosenRoute,loadRouting} from './routing.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
// Recalculate only unpurchased preparation metadata. Existing or uncertain
// shipments retain every carrier/parcel/weight field and every document.
export async function selectedPreparationRouting(db,orderId,plan){
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  if(!o||o.archived||o.partial_mode)throw Error('Transport sélectionné : commande indisponible ou partielle');
  const cancelled=cancellationBlock(o);if(cancelled)throw Error(cancelled);
  const job=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
  const protectedRow=(await tx.query(`SELECT EXISTS(SELECT 1 FROM carrier_documents WHERE order_id=$1)
   OR EXISTS(SELECT 1 FROM carrier_label_history WHERE order_id=$1)
   OR EXISTS(SELECT 1 FROM temu_label_documents WHERE reference=$2)
   OR EXISTS(SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0))
   OR EXISTS(SELECT 1 FROM extra_parcels WHERE order_id=$1)
   OR EXISTS(SELECT 1 FROM partial_deliveries WHERE order_id=$1) AS protected`,[orderId,o.reference])).rows[0];
  if(typeof protectedRow?.protected!=='boolean')throw Error('Transport sélectionné : étiquettes existantes non vérifiables');
  const attempted=job&&(job.environment!=='production'||job.status!=='pending'||Number(job.attempts)!==0||job.result!=null||job.reference||!Array.isArray(job.tracking)||job.tracking.length);
  if(protectedRow.protected||attempted||['shipped','in_transit','delivered','delivered_simulated'].includes(o.tracking_status))return {preserved:true};
  if(plan.missing.length){
   await tx.query('UPDATE orders SET weight_kg=null WHERE id=$1',[orderId]);
   return {weight:null,missing:true};
  }
  if(!Number.isFinite(plan.weightKg)||plan.weightKg<=0)throw Error('Transport sélectionné : poids non vérifié');
  const route=chosenRoute(o,plan.weightKg,await loadRouting(tx));
  if(job&&route.carrier==='temu')throw Error('Transport sélectionné : étiquette transporteur en attente sur une commande TEMU');
  await tx.query('UPDATE orders SET weight_kg=$2,parcel_count=$3,carrier=$4 WHERE id=$1',[orderId,route.weight,route.parcels,route.carrier]);
  if(job)await tx.query('UPDATE carrier_jobs SET carrier=$2,updated_at=now() WHERE order_id=$1',[orderId,route.carrier.startsWith('gls')?'gls':route.carrier]);
  return route;
 });
}
