import {randomUUID} from 'node:crypto';
import {excelCommercialSource} from './temu-excel-commercial.mjs';
import {assertExcelRenewal} from './temu-excel-renewal.mjs';

export const staleExcelCalculationError='Excel : prix ou articles modifiés depuis la validation';
export function unchangedExcelCalculation(o,lines){
 const saved=o.source_payload?.temuExcelCommercial;
 if(!saved||saved.source!=='temu_excel'||!saved.fingerprint)return null;
 const current=excelCommercialSource(o,lines);
 return current.fingerprint===saved.fingerprint&&current.currency===saved.currency?current:null;
}

// Continue only an already requested preparation with exactly the same raw
// source. Source edits still require explicit renewal. All native pre-document
// renewal protections, including uncertain product/label attempts, stay active.
export async function resumeUnchangedExcelReviews(db,{afterId='',limit=25}={}){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Lot Excel invalide');
 const rows=(await db.query(`SELECT o.id FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
  WHERE o.channel='temu' AND o.source_payload->>'origin'='temu_excel'
  AND o.source_payload->'temuExcelPreparation'->>'jobId' IS NOT NULL
  AND NOT o.archived AND e.status='review' AND e.error=$2
  ORDER BY (o.id>$1) DESC,o.id LIMIT $3`,[afterId,staleExcelCalculationError,limit])).rows;
 let resumed=0;
 for(const candidate of rows){
  const changed=await db.transaction(async tx=>{
   const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
   if(!o)return false;
   const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id FOR UPDATE',[o.id])).rows;
   let commercial,proof;
   try{
    commercial=unchangedExcelCalculation(o,lines);if(!commercial)return false;
    proof=await assertExcelRenewal(tx,o,lines);
   }catch(e){if(/^Revalidation Excel :|^Excel :/.test(e.message))return false;throw e;}
   // assertExcelRenewal already limits historical resume/refresh reviews to
   // known local pre-document errors. Their original results are retained;
   // the native worker must evaluate titles/VAT against the same source again.
   if(proof.job?.status!=='review'||proof.job.error!==staleExcelCalculationError)return false;
   const at=new Date().toISOString(),jobId=randomUUID(),old=o.source_payload;
   const history=[...(old.temuExcelValidationHistory||[]),{commercial:old.temuExcelCommercial,preparation:old.temuExcelPreparation,revalidatedAt:at,reason:'unchanged_excel_source_current_calculation',automatic:true}];
   const preparation={...old.temuExcelPreparation,jobId,previousJobId:old.temuExcelPreparation.jobId,calculationRecoveredAt:at};
   await tx.query('UPDATE orders SET source_payload=source_payload||$2::jsonb,issue=null,resolution_pending_resume=true WHERE id=$1',[o.id,JSON.stringify({temuExcelCommercial:commercial,temuExcelPreparation:preparation,temuExcelValidationHistory:history})]);
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1 AND status='review'",[o.id]);
   for(const review of proof.reviews)await tx.query("UPDATE resolution_jobs SET status='complete',stage='Calcul Excel actualisé : source inchangée',error=null,result=$2::jsonb WHERE id=$1 AND status='review'",[review.id,JSON.stringify({previousReview:review,revalidatedBy:jobId,documentsModified:false})]);
   await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload) VALUES($1,$2,$1,'resume',$3)",[jobId,o.id,JSON.stringify({id:o.id,requestId:jobId,action:'resume',type:'resolved'})]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.excel.unchanged_calculation_resumed',$1)",[JSON.stringify({orderId:o.id,jobId,sourceFingerprint:commercial.fingerprint,previousCommercial:old.temuExcelCommercial,currentCommercial:commercial,previousErpReview:proof.job,previousReviews:proof.reviews,externalWritesIssued:0})]);
   return true;
  });
  if(changed)resumed++;
 }
 return {resumed,checked:rows.length,afterId:rows.at(-1)?.id||'',providerWrites:0};
}
