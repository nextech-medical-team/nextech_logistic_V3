export const correctedParcelDiagnostic='Nombre de colis corrigé · préparation à vérifier';
const present=x=>['string','number'].includes(typeof x)&&String(x).trim()!==''&&String(x)!=='0';
export function planCompletedParcelDiagnostic(e,{now=Date.now()}={}){
 const {order:o,review:r,erp,bc,labels,ledger,checkedAt,busy=false,otherErrors=[]}=e;
 const no=reason=>({eligible:false,reason});
 if(!o||o.channel!=='temu'||o.archived||o.duplicate_of||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||['cancelled','cancellation_requested'].includes(o.label_status)||o.tracking_status==='cancelled')return no('protected_scope');
 if(o.issue||o.resolution_pending_resume||o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold||o.source_payload?.marketplacePendingCorrection||busy||otherErrors.length)return no('independent_blocker');
 if(Number(o.parcel_count)!==1||!(Number(o.weight_kg)>0))return no('parcel_correction_unconfirmed');
 if(erp?.status!=='complete'||erp.error!==null||o.erp_live?.phase!=='bl_ready'||r?.order_id!==o.id||r.action!=='replace-equivalent'||r.status!=='review'||r.error!==correctedParcelDiagnostic||r.result?.equivalent!==true||r.result.erpOnly!==true||r.result.regenerateExisting!==false||r.result.temuLabelPreserved!==true)return no('different_diagnostic');
 const at=Date.parse(checkedAt);if(!Number.isFinite(at)||at>now||now-at>300000)return no('fresh_read_required');
 if(![o.erp_live.bc?.id,o.erp_live.bl?.id,bc?.id].every(present)||String(bc.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||bc.external_reference!==o.reference||bc.update_stock!==true||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false)return no('bc_unconfirmed');
 const active=(bc.shipping_orders.data||[]).filter(b=>!['cancelled','unpublished'].includes(b.status));
 if(active.length!==1||String(active[0].id)!==String(o.erp_live.bl.id)||active[0].external_reference!==o.reference||!['ready_to_ship','shipped','delivered','completed'].includes(active[0].status)||active[0].update_stock!==true)return no('bl_unconfirmed');
 const historical=o.erp_live.historicalStockProof;
 if(!historical||historical.stockOnBc!==true||String(historical.bcId)!==String(bc.id)||!Array.isArray(historical.logIds)||!historical.logIds.length||o.erp_live.stockDocument?.id||o.erp_live.stockCreationAttemptedAt||ledger?.complete!==true||ledger.noAdditionalStockRemoval!==true||!Array.isArray(ledger.rows)||!historical.logIds.every(id=>ledger.rows.some(l=>String(l.id)===String(id)&&String(l.document_id)===String(bc.id)&&l.order_type==='Order')))return no('historical_stock_unconfirmed');
 const saved=r.result.preservedLabels;
 if(!Array.isArray(labels)||labels.length!==1||!Array.isArray(saved)||saved.length!==1||labels.some(l=>l.source!=='temu_direct'||l.jobStatus!=='complete'||l.jobError!==null||!l.package||!(l.bytes>0)||l.signature!=='%PDF-'||!/^([a-f0-9]{64})$/.test(l.sha256)||!saved.some(s=>s.key==='temu:'+o.reference+':'+l.package&&s.sha256===l.sha256)))return no('preserved_label_unconfirmed');
 return {eligible:true,resolutionTechnicalPatch:{status:'complete',error:null,stage:'Diagnostic résolu · Colis et documents existants confirmés'},proof:{checkedAt,bcId:bc.id,blId:active[0].id,ledgerIds:historical.logIds.map(String),labels,previousError:correctedParcelDiagnostic},providerWrites:0,newJobs:[],labelsModified:0,businessCompleted:false};
}
