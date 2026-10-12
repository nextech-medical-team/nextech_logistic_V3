export const completedMapError="Cannot read properties of undefined (reading 'map')";
const idPresent=id=>['string','number'].includes(typeof id)&&String(id).trim()!==''&&String(id)!=='0';
export function planCompletedMapDiagnostic(e,{now=Date.now()}={}){
 const {order:o,review:r,erp,bc,stock,labels,checkedAt,busy=false,otherErrors=[]}=e;
 const no=reason=>({eligible:false,reason});
 if(!o||o.channel!=='temu'||o.archived||o.duplicate_of||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||['cancelled','cancellation_requested'].includes(o.label_status)||o.tracking_status==='cancelled')return no('dedicated_scope');
 if(o.issue||o.resolution_pending_resume||o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold||o.source_payload?.marketplacePendingCorrection||busy||otherErrors.length)return no('independent_or_policy_blocker');
 if(o.erp_live?.phase!=='bl_ready'||erp?.status!=='review'||erp.error!==completedMapError||r?.order_id!==o.id||r.status!=='review'||r.action!=='replace-equivalent'||r.error!==completedMapError||r.result?.equivalent!==true||r.result.erpOnly!==true||r.result.regenerateExisting!==false||r.result.temuLabelPreserved!==true)return no('different_diagnostic');
 const at=Date.parse(checkedAt);if(!Number.isFinite(at)||at>now||now-at>300000)return no('fresh_read_required');
 if(![o.erp_live.bc?.id,o.erp_live.bl?.id,o.erp_live.stockDocument?.id,bc?.id,stock?.id].every(idPresent))return no('identity_missing');
 if(String(bc.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||bc.external_reference!==o.reference||bc.update_stock!==false||bc.shipping_orders?.paginatorInfo?.hasMorePages!==false)return no('bc_unconfirmed');
 const active=(bc.shipping_orders.data||[]).filter(b=>!['cancelled','unpublished'].includes(b.status));
 if(active.length!==1||String(active[0].id)!==String(o.erp_live.bl.id)||active[0].external_reference!==o.reference||!['ready_to_ship','shipped','delivered','completed'].includes(active[0].status)||active[0].update_stock!==false)return no('bl_unconfirmed');
 if(String(stock.id)!==String(o.erp_live.stockDocument.id)||stock.status!=='completed'||stock.update_stock!==true||stock.notes!=='LIVE : sortie de stock liée au BL '+active[0].label)return no('stock_unconfirmed');
 const saved=r.result.preservedLabels;
 if(!Array.isArray(saved)||!saved.length||!Array.isArray(labels)||saved.length!==labels.length||labels.some(l=>l.source!=='temu_direct'||l.jobStatus!=='complete'||l.jobError!==null||l.signature!=='%PDF-'||!(l.bytes>0)||!l.package||!/^([a-f0-9]{64})$/.test(l.sha256)||!saved.some(s=>s.key==='temu:'+o.reference+':'+l.package&&s.sha256===l.sha256)))return no('preserved_label_unconfirmed');
 return {eligible:true,erpTechnicalPatch:{status:'complete',error:null},resolutionTechnicalPatch:{status:'complete',error:null,stage:'Diagnostic résolu · BL existant confirmé'},proof:{checkedAt,bcId:bc.id,blId:active[0].id,stockId:stock.id,labels,previousError:completedMapError},newJobs:[],providerWrites:0,labelsModified:0,businessCompleted:false};
}
