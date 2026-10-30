import {createHash} from 'node:crypto';
import {assertBlBatchNumbers} from './bl-batch-required.mjs';

export function batchDiagnosticOnly(error){
 return typeof error==='string'&&error.split(' ; ').every(part=>/^BL · Lot de traçabilité Erplain · .+ : .+ — création BL bloquée$/.test(part));
}

// A failed stable continuation must wake when the missing lots are corrected.
// Read actual Erplain lots before changing its identity; never clear the error
// or enqueue a provider write here. The normal continuation keeps all guards.
export async function batchContinuationFingerprint(db,api,order){
 const job=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[order.id])).rows[0];
 if(job?.status!=='review'||!batchDiagnosticOnly(job.error))return null;
 const observations=[];
 const reader={async request(query,variables){
  if(!/^query\s/.test(query))throw Error('Lots · Lecture seule requise');
  const data=await api.request(query,variables);
  if(data.Variant)observations.push(['variant',String(data.Variant.id),data.Variant.has_batch_numbers]);
  for(const batch of data.BatchNumbers?.data||[])observations.push(['batch',String(batch.variant_id),String(batch.id),batch.label]);
  return data;
 }};
 await assertBlBatchNumbers(reader,order,order.erp_live?.bc?.line_items);
 observations.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return createHash('sha256').update(JSON.stringify(observations)).digest('hex');
}
