export const staleDeliveredReason='Préparation V3 à vérifier · Statut BL Erplain à rapprocher · actualisation demandée, en erreur ou échue';
const idPresent=id=>['string','number'].includes(typeof id)&&String(id).trim()!==''&&String(id)!=='0';
// Preparation diagnostic only. No resume, provider operation or content comparison.
export function planDeliveredDiagnostic(e,{now=Date.now()}={}){
 const {order:o,bc,stock,checkedAt,labels,erp,otherErrors=[],busy=false}=e;
 const refuse=reason=>({eligible:false,reason});
 if(!o||o.issue!==staleDeliveredReason||!['shopify','amazon','temu'].includes(o.channel))return refuse('different_diagnostic');
 if(o.archived||o.duplicate_of||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||['cancelled','cancellation_requested'].includes(o.label_status)||o.tracking_status!=='delivered')return refuse('dedicated_or_suspended_scope');
 if(o.source_payload?.postBcContentFreeze?.enabled!==true||o.source_payload?.marketplacePendingCorrection)return refuse('await_bc_policy');
 if(o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold||otherErrors.length||busy)return refuse('independent_blocker');
 if(erp?.status!=='complete'||erp.error!==null)return refuse('erp_unconfirmed');
 if(![o.erp_live?.bc?.id,o.erp_live?.bl?.id,o.erp_live?.stockDocument?.id,bc?.id,stock?.id].every(idPresent))return refuse('document_identity_missing');
 const at=Date.parse(checkedAt);if(!Number.isFinite(at)||at>now||now-at>300000)return refuse('fresh_read_required');
 if(String(bc?.id)!==String(o.erp_live?.bc?.id)||bc.status!=='active'||bc.external_reference!==o.reference||bc.update_stock!==false||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false)return refuse('bc_unconfirmed');
 const active=(bc.shipping_orders.data||[]).filter(b=>!['cancelled','unpublished'].includes(b.status));
 if(active.length!==1||String(active[0].id)!==String(o.erp_live?.bl?.id)||active[0].external_reference!==o.reference||active[0].status!=='delivered'||active[0].update_stock!==false)return refuse('delivered_bl_unconfirmed');
 if(String(stock?.id)!==String(o.erp_live?.stockDocument?.id)||stock.status!=='completed'||stock.update_stock!==true||stock.notes!=='LIVE : sortie de stock liée au BL '+active[0].label)return refuse('stock_document_unconfirmed');
 if(!Array.isArray(labels)||!labels.length||labels.some(l=>l.environment!=='production'||l.signature!=='%PDF-'||!(l.bytes>0)||!l.tracking||!l.sha256))return refuse('existing_label_unconfirmed');
 return {eligible:true,technicalPatch:{issue:null,resolution_pending_resume:false,label_status:'production_ready'},proof:{checkedAt,bcId:bc.id,blId:active[0].id,stockId:stock.id,labels,previousReason:o.issue},newJobs:[],providerWrites:0,labelsModified:0,businessCompleted:false};
}
