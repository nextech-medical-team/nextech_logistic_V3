import {cancellationBlock} from './erp-transient-policy.mjs';
// A recovered observation is not an operator correction. Requeue only initial
// dossiers with no external creation phase and no correction history.
export async function recoverCompleteTemuImport(tx,existing,order,receipt){
 if(receipt.channel!=='temu')return false;
 const s=existing.erp_live||{};
 if(existing.archived||existing.partial_mode||cancellationBlock(existing)||s.phase||s.customer?.id||s.bc?.id||s.bl?.id||s.stockDocument?.id||s.stockCreationAttemptedAt||order.cancelled||order.fulfilled||!order.lines?.length)return false;
 if((await tx.query(`SELECT 1 FROM resolution_jobs WHERE order_id=$1 UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1`,[existing.id])).rows.length)return false;
 const job=(await tx.query('SELECT status FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[existing.id])).rows[0];
 if(job&&job.status!=='review'&&job.status!=='pending')return false;
 const link=await tx.query(`INSERT INTO marketplace_order_links(channel,shop,reference,order_id,version) VALUES('temu',$1,$2,$3,$4)
  ON CONFLICT(channel,shop,reference) DO UPDATE SET version=excluded.version WHERE marketplace_order_links.order_id=excluded.order_id RETURNING order_id`,[receipt.shop,order.reference,existing.id,order.version||null]);
 if(!link.rows.length)throw Error('TEMU · Référence rattachée à un autre dossier : rapprochement nécessaire');
 await tx.query(`UPDATE orders SET resolution_pending_resume=false,issue=null,source_payload=source_payload||'{"temuLabelPurchaseConfirmationRequired":true}'::jsonb WHERE id=$1`,[existing.id]);
 await tx.query(`INSERT INTO erp_live_jobs(order_id,status,error) VALUES($1,'pending',null)
  ON CONFLICT(order_id) DO UPDATE SET status='pending',error=null,updated_at=now() WHERE erp_live_jobs.status='review'`,[existing.id]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.complete_import_recovered',$1)",[JSON.stringify({orderId:existing.id,externalWrites:0,labelPurchaseUnchanged:true})]);
 return true;
}
