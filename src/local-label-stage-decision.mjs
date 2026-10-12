import {shipmentFingerprint} from './label-stock-gate.mjs';

// Explicit local human decisions only. This never creates or modifies a document.
export function matchesLabelStageDecision(o,d,fingerprint,{erp,carrier}={}){
 return !!(d?.decision==='remove_label_stage_error_only'&&d.orderId===o?.id&&d.reference===o.reference&&d.fingerprint===fingerprint&&d.bcId===String(o.erp_live?.bc?.id)&&d.blId===String(o.erp_live?.bl?.id)&&o.channel!=='temu'&&!o.archived&&!o.duplicate_of&&!o.partial_mode&&!o.issue&&!o.suspension?.active&&!o.suspension?.erplainCancellation&&!o.source_payload?.marketplacePendingCorrection&&erp?.status==='complete'&&!erp.error&&!carrier&&o.erp_live?.verifiedAt&&o.erp_live?.stockCheckedAt&&o.erp_live?.stockDocument?.id&&o.erp_live.labelPreparationFingerprint===fingerprint);
}
export async function preserveLabelStageDecision(db,id){
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o)return false;
 const d=(await db.query('SELECT state FROM order_recheck_monitor WHERE order_id=$1',[id])).rows[0]?.state?.localHumanDecision;
 if(d?.decision!=='remove_label_stage_error_only')return false;
 const erp=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0],carrier=(await db.query('SELECT status FROM carrier_jobs WHERE order_id=$1',[id])).rows[0];
 if(!matchesLabelStageDecision(o,d,await shipmentFingerprint(db,o),{erp,carrier}))return false;
 await db.query("UPDATE orders SET resolution_pending_resume=false,label_status='pending' WHERE id=$1",[id]);
 return true;
}
