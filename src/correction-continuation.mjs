// Continue only the correction explicitly requested for this order. Never sweep
// historical reviews or replay a commercial mutation to obtain a new proof.
import {createHash,randomUUID} from 'node:crypto';

export const continuationActions = new Set(['manual-temu-pricing','choose-carrier','mapping','weight','create-product','activate-product','select-product','address','relay','refresh','accept-source-change']);
export async function continueSuccessfulCorrection(j,result,{recheck,resume,review}) {
 if(result.readOnly || j.payload.resumeAfter===false || !continuationActions.has(j.action))return false;
 if(result.usable===false){await review(result.message || ('Produit Erplain à vérifier : '+(result.status||'non utilisable')),result);return true;}
 const erpOnly=result.erpOnly || ['mapping','weight','create-product','activate-product','select-product','accept-source-change'].includes(j.action);
 let current=result.checks?.find(x=>x.id===j.order_id);
 // A protected order or an unresolved SKU is not a completed correction.
 if(!current){const checks=await recheck([j.order_id]);result.checks=[...(result.checks||[]),...checks];current=checks.find(x=>x.id===j.order_id);}
 if(!current?.prepared){await review(current?.problem || (current?.protected?'Préparation protégée : vérifier la commande':'Préparation non vérifiée : correction enregistrée, suite à contrôler'),result);return true;}
 await resume({...j,result:{...result,erpOnly:!!erpOnly},action:'resume',payload:{...j.payload,action:'resume',type:'resolved'}});
 return true;
}

const financialReason=/^TEMU · (Remises client et TVA à rapprocher|Totaux client source incohérents|Prix client et TVA source incohérents)$/;
export function historicalPriceContinuationAllowed(o,job,{action,bc,pricing}) {
 const p=o.source_payload||{},s=o.erp_live||{};
 return action==='update_prices' && o.channel==='temu' && o.archived===false && !o.partial_mode
  && !['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)
  && o.label_status!=='cancelled' && !String(o.reference||'').startsWith('DEMO-')
  && !Object.hasOwn(p,'marketplacePendingCorrection') && !p.visibilityHold && !p.erplainImported && !p.erplainValidationHold



  && !!p.sourceShop && p.selectedReimport?.mode==='hold' && financialReason.test(p.selectedReimport.reason||'')
  && o.resolution_pending_resume===true && s.phase==='historical_review'
  && !s.bl?.id && !s.stockDocument?.id && !s.stockCreationAttemptedAt
  && job?.status==='review' && (job.error==='Reprise historique à vérifier : BL non créé' || financialReason.test(job.error||''))
  && (!o.issue || o.issue===job.error || o.issue==='Reprise historique à vérifier : BL non créé')
  && !!s.bc?.id && String(bc?.id)===String(s.bc?.id) && bc?.status==='active' && bc?.external_reference===o.reference
  && Number(bc.invoices_count)===0 && Number(bc.paid_amount)===0
  && bc.shipping_orders?.paginatorInfo?.hasMorePages===false && Array.isArray(bc.shipping_orders?.data) && bc.shipping_orders.data.length===0
  && pricing?.status==='verified' && !pricing.error && !!pricing.confirmed && Number.isFinite(Date.parse(pricing.verifiedAt));
}
export async function queueHistoricalPriceContinuation(tx,o,job,proof){
 if(!historicalPriceContinuationAllowed(o,job,proof))return false;
 if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','review')",[o.id])).rows.length)return false;
 const id=randomUUID(),requestId='price-continuation-'+createHash('sha256').update(o.id+':'+proof.pricing.verifiedAt).digest('hex');
 const payload={id:o.id,requestId,action:'resume',type:'resolved',resumeAfter:true};
 const result={erpOnly:true,commercialCorrectionVerifiedAt:proof.pricing.verifiedAt,existingLabelsPreserved:true};
 const inserted=await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,result) VALUES($1,$2,$3,'resume',$4,$5) ON CONFLICT(request_id) DO NOTHING RETURNING id",[id,o.id,requestId,JSON.stringify(payload),JSON.stringify(result)]);
 if(!inserted.rows.length)return false;
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','correction.continuation_requested',$1)",[JSON.stringify({orderId:o.id,resolutionId:id,bcId:proof.bc.id,verifiedAt:proof.pricing.verifiedAt,erpOnly:true})]);
 return true;
}
