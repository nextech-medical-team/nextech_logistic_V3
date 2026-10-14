import {canRetryFailedCarrier,hasUncertainCarrierHistory} from './carrier-attempt-proof.mjs';
import {randomUUID} from 'node:crypto';
import {assertManualLabelOrder} from './manual-label-policy.mjs';
import {tenderBlLabelPayload} from './tender-bl-label-payload.mjs';

export function assertBlLabelRequest(o){
 if(o?.channel==='temu')throw Error('Générer l’étiquette dans le parcours TEMU');
 assertManualLabelOrder(o,o?.carrier,{manualChoice:true});
 if(!o.erp_live?.bl?.id)throw Error('Saisir le BL avant de générer l’étiquette');
 if(o.erp_live.bl.status==='cancelled')throw Error('BL annulé : génération indisponible');
 if(!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier))throw Error('Choisir le transporteur');
}

// Explicit user action: preparation, stock, fiscal checks and Erplain are excluded.
// The order lock and persisted carrier result prevent a second shipment.
export async function queueLabelFromBl(db,id,user){
 if(typeof id!=='string'||!id)throw Error('Commande requise');
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assertBlLabelRequest(o);
  const job=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
  if(job&&['ready','pending','creating','awaiting_pdf'].includes(job.status))return {id,status:job.status,existing:true};
  if(job&&!await canRetryFailedCarrier(tx,job,{manualRequest:true}))throw Error('Création existante ou incertaine : rapprocher son résultat');
  for(const table of ['carrier_documents','extra_parcels']){
   if((await tx.query(`SELECT 1 FROM ${table} WHERE order_id=$1 LIMIT 1`,[id])).rows.length)throw Error('Étiquette ou colis existant à conserver');
  }
  if(await hasUncertainCarrierHistory(tx,id,{manualRequest:true}))throw Error('Étiquette ou création incertaine dans l’historique : rapprocher son résultat');
  if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') LIMIT 1",[id])).rows.length)throw Error('Modification en cours : attendre sa fin');
  const request={blId:String(o.erp_live.bl.id),creationId:randomUUID(),requestedBy:user.email,at:new Date().toISOString()};
  const blPayload=await tenderBlLabelPayload(tx,o);if(blPayload){request.blPayload=blPayload;request.previousParcelCalculation={weightKg:o.weight_kg,parcels:o.parcel_count};}
  await tx.query("INSERT INTO carrier_jobs(order_id,carrier,status,environment,creation_id,manual_bl_request) VALUES($1,$2,'pending','production',$3,$4) ON CONFLICT(order_id) DO UPDATE SET carrier=excluded.carrier,status='pending',environment='production',creation_id=excluded.creation_id,manual_bl_request=excluded.manual_bl_request,attempts=0,error=null,failure_phase=null,creation_started_at=null,updated_at=now()",[id,o.carrier.startsWith('gls')?'gls':'gofo',request.creationId,JSON.stringify(request)]);
  await tx.query("UPDATE orders SET label_status='production_pending',processing_priority_at=now() WHERE id=$1",[id]);
  if(blPayload)await tx.query('UPDATE orders SET weight_kg=$2,parcel_count=$3 WHERE id=$1',[id,blPayload.weightKg,blPayload.parcels]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'label.manual_from_bl',$2)",[user.email,JSON.stringify({orderId:id,...request})]);
  return {id,status:'pending',existing:false};
 });
}

export function assertBlLabelWorker(o,request){
 assertBlLabelRequest(o);
 if(!request?.requestedBy||!request.at||request.blId!==String(o.erp_live.bl.id))throw Error('BL modifié après la demande d’étiquette');
}

export async function queueLabelBatchFromBl(db,ids,user){
 if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!id))throw Error('Sélectionner de 1 à 100 commandes');
 let queued=0;const skipped=[];
 for(const id of [...new Set(ids)].sort()){
  try{const result=await queueLabelFromBl(db,id,user);if(!result.existing)queued++;}
  catch(e){skipped.push({id,reason:e.message});}
 }
 return {queued,skipped,message:queued+' étiquette(s) mise(s) en génération'+(skipped.length?' · '+skipped.length+' commande(s) non lancée(s) : '+skipped.map(s=>s.reason).join(' ; '):'')};
}
