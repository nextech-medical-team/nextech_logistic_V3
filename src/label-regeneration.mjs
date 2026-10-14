import {assertDirectCarrierAllowed} from './temu-label-policy.mjs';
import {assertTemuManualLabel} from './manual-label-policy.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {canRetryFailedCarrier} from './carrier-attempt-proof.mjs';
import {randomUUID} from 'node:crypto';import {addressIssue} from './domain.mjs';
export async function regenerateProductionLabels(db,{batchId=randomUUID(),ids=null,allowReady=false,stockOverride=null,manualRequest=false}={}){
 if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')))throw Error('Liste de commandes invalide');
 const rows=(await db.query(ids===null?"SELECT * FROM orders ORDER BY received_at,id":"SELECT * FROM orders WHERE id=ANY($1::text[]) ORDER BY received_at,id",ids===null?[]:[ids])).rows;let queued=0;const skipped=[];
 for(const o of rows){
  let reason=o.reference.startsWith('DEMO-')?'Commande fictive':o.channel==='temu'&&!o.transport_choice?'Circuit TEMU achat séparé':o.partial_mode?'Livraisons partielles à traiter séparément':!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier)?'Transporteur non déterminé':addressIssue(o.address)||(!(Number(o.weight_kg)>0)?'Poids absent':null);
  if(!reason)try{assertDirectCarrierAllowed(o,o.carrier);if(o.channel==='temu')assertTemuManualLabel((await db.query('SELECT status FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0]);}catch(e){reason=e.message;}
  if(!reason&&(!Number.isInteger(Number(o.parcel_count))||Number(o.parcel_count)<1))reason='Nombre de colis absent';
  if(!reason)try{await assertLabelStockGate(db,o,stockOverride);}catch(e){reason=e.message;}
  if(reason){skipped.push({id:o.id,reference:o.reference,reason});continue;}
  await db.transaction(async tx=>{
   const job=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
   if(job?.batch_id===batchId)return;
   if(job?.status==='failed'&&!await canRetryFailedCarrier(tx,job,{manualRequest})){skipped.push({id:o.id,reference:o.reference,reason:'Création précédente à rapprocher : aucune reprise automatique ou incertaine'});return;}
   if(job?.status==='ready'&&!allowReady){skipped.push({id:o.id,reference:o.reference,reason:'Étiquette déjà disponible : conserver le PDF existant'});return;}
   if(job&&(['pending','creating','awaiting_pdf'].includes(job.status)||(job.environment==='production'&&(job.status==='review'||(job.result&&!(allowReady&&job.status==='ready')))))){skipped.push({id:o.id,reference:o.reference,reason:'Création en cours ou incertaine : vérifier avant recréation'});return;}
   if(job){const historyId=randomUUID();await tx.query('INSERT INTO carrier_label_history(id,order_id,job) VALUES($1,$2,$3)',[historyId,o.id,JSON.stringify(job)]);await tx.query('INSERT INTO carrier_label_history_documents SELECT $1,document_index,pdf FROM carrier_documents WHERE order_id=$2',[historyId,o.id]);}
   await tx.query('DELETE FROM carrier_documents WHERE order_id=$1',[o.id]);
   await tx.query("INSERT INTO carrier_jobs(order_id,carrier,status,environment,creation_id,batch_id,stock_override) VALUES($1,$2,'pending','production',$3,$4,$5) ON CONFLICT(order_id) DO UPDATE SET carrier=excluded.carrier,status='pending',environment='production',creation_id=excluded.creation_id,batch_id=excluded.batch_id,stock_override=excluded.stock_override,reference=null,tracking='[]',result=null,attempts=0,error=null,failure_phase=null,creation_started_at=null,updated_at=now()",[o.id,o.carrier.startsWith('gls')?'gls':'gofo',randomUUID(),batchId,stockOverride?JSON.stringify(stockOverride):null]);
   await tx.query("UPDATE orders SET label_status='production_pending',issue=null WHERE id=$1",[o.id]);
   await tx.query("UPDATE jobs SET status='complete',error=null WHERE order_id=$1 AND kind='label'",[o.id]);
   queued++;
  });
 }
 await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system','labels.production_regeneration.authorized',$1)",[JSON.stringify({batchId,queued,skipped,erplainChanged:false})]);
 return {batchId,queued,skipped};
}
