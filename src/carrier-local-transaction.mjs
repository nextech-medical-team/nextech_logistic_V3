// Retry only rolled-back local SQL, never the carrier HTTP operation.
export async function carrierLocalTransaction(db,fn,{sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;;attempt++){
  try{return await db.transaction(fn);}
  catch(error){if(!['40P01','40001'].includes(error?.code)||attempt>=2)throw error;await sleep(25*2**attempt);}
 }
}

export async function claimCarrierJob(db,carrier,{eligible,priority}){
 return carrierLocalTransaction(db,async tx=>{
  // Lock the order before its job, matching admission and the suspension guard.
  const candidate=(await tx.query(`SELECT orders.id FROM orders WHERE EXISTS(SELECT 1 FROM carrier_jobs WHERE carrier_jobs.order_id=orders.id AND carrier=$1 AND ${eligible}) ORDER BY processing_priority_at ASC NULLS LAST,(SELECT updated_at FROM carrier_jobs WHERE order_id=orders.id),id FOR UPDATE OF orders SKIP LOCKED LIMIT 1`,[carrier])).rows[0];
  if(!candidate)return null;
  const {rows}=await tx.query(`SELECT * FROM carrier_jobs WHERE order_id=$2 AND carrier=$1 AND ${eligible} ORDER BY ${priority} FOR UPDATE SKIP LOCKED LIMIT 1`,[carrier,candidate.id]);
  if(!rows.length)return null;
  await tx.query('UPDATE carrier_jobs SET status=$2,attempts=attempts+1,updated_at=now() WHERE order_id=$1',[rows[0].order_id,rows[0].status==='pending'?'creating':'awaiting_pdf']);
  return rows[0];
 });
}
