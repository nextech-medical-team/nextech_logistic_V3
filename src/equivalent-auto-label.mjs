import {randomUUID} from 'node:crypto';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {assertManualLabelOrder} from './manual-label-policy.mjs';
import {addressIssue} from './domain.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';

export function assertPreparedLabelOrder(o,e){
 assertManualLabelOrder(o,o?.carrier);
 const blocked=cancellationBlock(o)||o.source_payload?.erplainValidationHold&&'Validation Erplain suspendue'||o.source_payload?.marketplacePendingCorrection&&'Commande modifiée sur la plateforme'||o.duplicate_of&&'Commande en doublon'||o.issue;
 if(blocked)throw Error(String(blocked));
 if(String(o.reference||'').startsWith('DEMO-'))throw Error('Commande fictive');
 if(e?.status!=='complete'||e.error)throw Error('Contrôle Erplain non terminé');
 if(o.erp_live?.phase!=='bl_ready'||o.erp_live?.bc?.status!=='active'||o.erp_live?.bl?.status!=='ready_to_ship')throw Error('BL non prêt à livrer');
 if(addressIssue(o.address))throw Error(addressIssue(o.address));
 if(!(Number(o.weight_kg)>0))throw Error('Poids du colis absent');
 const count=o.channel==='temu'?1:Number(o.parcel_count);
 if(!Number.isInteger(count)||count<1)throw Error('Nombre de colis absent');
}

// One order lock covers proof, duplicate protection, queue insertion and hold release.
// No carrier request or Erplain mutation happens in this transaction.
export async function advanceEquivalentLabel(db,job,{repair=false}={}){
 if(job.action!=='replace-equivalent'&&!job.result?.equivalent)return {handled:false};
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[job.order_id])).rows[0];
  if(!o)throw Error('Commande introuvable');
  const j=(await tx.query('SELECT * FROM resolution_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(!j||!(j.status==='waiting'||repair&&j.status==='complete'))return {handled:true,state:'unchanged'};
  if(o.partial_mode||j.result?.partialRemainder)return {handled:false};
  const busy=(await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND id<>$2 AND status IN ('queued','running','waiting')",[o.id,j.id])).rows;
  if(busy.length)return {handled:true,state:'busy'};
  const latest=(await tx.query('SELECT id,status,created_at FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[o.id])).rows[0];
  if(latest?.status==='review'&&latest.id!==j.id)throw Error('Correction plus récente à vérifier avant étiquette');
  const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[o.id])).rows[0];
  if(e?.status==='pending'||e?.status==='processing')return {handled:true,state:'erp_waiting'};
  assertPreparedLabelOrder(o,e);
  await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[o.id]);
  await assertLabelStockGate(tx,o);
  const result={...j.result,automaticEquivalentLabel:true,erpOnly:false,regenerateExisting:false};
  const save=async(status,stage,message)=>{
   await tx.query("UPDATE resolution_jobs SET status=$2,stage=$3,result=$4,error=null,updated_at=now() WHERE id=$1",[j.id,status,stage,JSON.stringify({...result,message})]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','equivalent.label_automatic',$1)",[JSON.stringify({orderId:o.id,resolutionId:j.id,status,stage,repair})]);
  };
  const c=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
  const docs=(await tx.query('SELECT document_index FROM carrier_documents WHERE order_id=$1',[o.id])).rows;
  if(c){
   if(c.environment!=='production')throw Error('Ancienne étiquette TEST à rapprocher');
   if(c.status==='ready'){
    if(!docs.length)throw Error('Étiquette créée : récupérer le PDF existant');
    await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
    await save('complete','Terminé','Étiquette existante conservée. Produit équivalent et BL validés.');return {handled:true,state:'preserved'};
   }
   if(['pending','creating','awaiting_pdf'].includes(c.status)){
    await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
    await save('waiting','Création automatique de l’étiquette PROD','Création déjà en cours : suivi sans nouvel achat.');return {handled:true,state:'waiting'};
   }
   throw Error(c.error||'Création transporteur échouée ou incertaine : vérifier avant tout nouvel achat');
  }
  if(docs.length)throw Error('PDF existant sans traitement associé : rapprochement requis');
  const history=(await tx.query('SELECT id FROM carrier_label_history WHERE order_id=$1 LIMIT 1',[o.id])).rows;
  const extras=(await tx.query("SELECT id FROM extra_parcels WHERE order_id=$1 AND status<>'failed' LIMIT 1",[o.id])).rows;
  if(history.length||extras.length)throw Error('Historique transporteur existant : rapprochement requis');
  const temu=(await tx.query('SELECT status,packages,attempt_id FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];
  if(o.channel==='temu'&&!o.transport_choice){
   const td=(await tx.query('SELECT package FROM temu_label_documents WHERE reference=$1',[o.reference])).rows;
   if(temu?.status==='complete'&&temu.packages?.length&&temu.packages.every(p=>td.some(d=>d.package===p))){
    await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
    await save('complete','Terminé','Étiquette TEMU existante conservée. Produit équivalent et BL validés.');return {handled:true,state:'preserved_temu'};
   }
   throw Error('Étiquette TEMU à préparer dans le circuit TEMU ; aucun achat transporteur direct');
  }
  if(temu&&(temu.attempt_id||temu.packages?.length))throw Error('Expédition TEMU existante : rapprochement requis');
  if(!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier))throw Error('Transporteur non déterminé');
  const inserted=await tx.query("INSERT INTO carrier_jobs(order_id,carrier,status,environment,creation_id,batch_id) VALUES($1,$2,'pending','production',$3,$4) ON CONFLICT(order_id) DO NOTHING RETURNING order_id",[o.id,o.carrier.startsWith('gls')?'gls':'gofo',randomUUID(),'equivalent-'+j.id]);
  if(inserted.rows.length!==1)throw Error('Traitement transporteur concurrent : aucune seconde création');
  result.labelRequested=true;
  await tx.query("UPDATE orders SET resolution_pending_resume=false,label_status='production_pending',issue=null WHERE id=$1",[o.id]);
  await save('waiting','Création automatique de l’étiquette PROD','Produit équivalent et BL validés : étiquette mise en création automatiquement.');
  return {handled:true,state:'queued',id:o.id};
 });
}
