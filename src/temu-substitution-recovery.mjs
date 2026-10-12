import {assertWholeTemuPackage} from './temu-label-pdf.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';
import {randomUUID} from 'node:crypto';

export const temuSubstitutionRecoveryError='Achat TEMU en cours, incertain ou multi-colis : récupérer et vérifier le colis avant remplacement';

export function verifiedSubstitutionPackage(order,job,lines,documents){
 if(!order||order.channel!=='temu'||order.archived||order.partial_mode||order.suspension?.active||order.suspension?.erplainCancellation||cancellationBlock(order)
 ||order.source_payload?.marketplacePendingCorrection||order.source_payload?.visibilityHold||!order.erp_live?.bc?.id||order.erp_live.bl?.id||order.erp_live.stockDocument
 ||/^(creating|publishing)/.test(order.erp_live.phase||'')||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))return false;
 if(job?.status!=='complete'||job.error||job.result?.source!=='temu_direct'||job.packages?.length!==1||!lines?.length)return false;
 const packageSn=job.packages[0];
 if(!/^PK-\d+$/.test(packageSn))return false;
 if(!documents.some(d=>d.package===packageSn&&Number(d.bytes)>0))return false;
 const originals=order.erp_live.equivalentOriginalLines||lines;
 if(!Array.isArray(originals)||!originals.length||originals.some(l=>!l.source_line||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))return false;
 try{assertWholeTemuPackage(order,originals,job.result,packageSn);}catch{return false;}
 return true;
}

// The preview fingerprint includes the parcel. Read it again after recovery;
// an earlier confirmation cannot authorize a changed parcel or BC.
export async function recoverTemuSubstitutionReviews(db,reference){
 return db.transaction(async tx=>{
  const order=(await tx.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1 FOR UPDATE",[reference])).rows[0];if(!order)return 0;
  const job=(await tx.query('SELECT * FROM temu_label_jobs WHERE reference=$1 FOR SHARE',[reference])).rows[0];
  const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 FOR SHARE',[order.id])).rows;
  const documents=(await tx.query('SELECT package,octet_length(pdf) bytes FROM temu_label_documents WHERE reference=$1 FOR SHARE',[reference])).rows;
  if(!verifiedSubstitutionPackage(order,job,lines,documents))return 0;
  if((await tx.query(`SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')
   UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')
   UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing'
   UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1`,[order.id])).rows.length)return 0;
  const latest=(await tx.query('SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[order.id])).rows[0];
  if(latest?.status!=='review'||latest.error!==temuSubstitutionRecoveryError||!['equivalent-preview','replace-equivalent'].includes(latest.action)||latest.payload?.importRow||latest.payload?.substitutionAttempt)return 0;
  // Quantities remain the operator's choice and are checked against the fresh BC.
  const id=randomUUID(),payload={...latest.payload,action:'equivalent-preview',requestId:randomUUID()};delete payload.previewFingerprint;delete payload.confirmEquivalent;
  await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,status,stage) VALUES($1,$2,$3,'equivalent-preview',$4::jsonb,'queued','Colis TEMU récupéré · nouvelle vérification du remplacement')",[id,order.id,payload.requestId,JSON.stringify(payload)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.substitution_recovered',$1)",[JSON.stringify({orderId:order.id,previousJobId:latest.id,jobId:id,package:job.packages[0],externalWrites:0,labelPurchaseUnchanged:true})]);
  return 1;
 });
}
