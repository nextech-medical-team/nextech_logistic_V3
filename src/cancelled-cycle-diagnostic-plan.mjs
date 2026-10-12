export const oldCycleDiagnostic='Stock Erplain : ancien cycle non identifié, rapprochement nécessaire';
export const currentCycleDiagnostic='Stock Erplain · Sortie de stock non confirmée pour le BL existant';
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
export function planCancelledCycleDiagnostic({order,erpJob,previousProof,currentBc,currentStock,labels,checkedAt},now=Date.now()){
 const o=order||{},s=o.erp_live||{},p=previousProof||{};
 const no=reason=>({eligible:false,reason});
 if(!o.id||o.archived||o.duplicate_of||o.partial_mode||o.resolution_pending_resume||o.suspension?.active===true||o.suspension?.erplainCancellation||['cancelled','cancellation_requested'].includes(o.label_status)||['cancelled','delivered','shipped','in_transit'].includes(o.tracking_status))return no('order_scope');
 if(o.issue&&o.issue!==oldCycleDiagnostic)return no('independent_issue');
 if(s.phase!=='creating_stock'||s.stockDocument||s.stockCreationAttemptedAt||s.stockCreationOutcome||s.documentSource?.stockHolds?.length||s.mappingAlignmentAttempt?.status==='uncertain')return no('stock_scope');
 if(erpJob?.error!==oldCycleDiagnostic||!['review','failed'].includes(erpJob.status))return no('erp_scope');
 if(!same(p.oldBcId,s.previousCancelledCycle?.bc?.id)||!same(p.currentBcId,s.bc?.id)||same(p.oldBcId,p.currentBcId)||p.oldBcCancelled!==true||p.oldBcManagedStock!==false||p.noShippingOrders!==true||p.noStockRemovals!==true||!Array.isArray(p.evidence)||!p.evidence.length||p.evidence.some(x=>x.complete!==true))return no('previous_cycle_unverified');
 if(!same(currentBc?.id,s.bc?.id)||currentBc.status!=='active'||currentBc.update_stock!==false||currentBc.external_reference!==o.reference||currentBc.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(currentBc.shipping_orders?.data)||currentBc.shipping_orders.data.length!==1)return no('current_bc_unverified');
 const bl=currentBc.shipping_orders.data[0];
 if(!same(bl.id,s.bl?.id)||bl.status!=='pending'||bl.update_stock!==false||bl.external_reference!==o.reference)return no('current_bl_unverified');
 if(currentStock?.label!=='V3FS-'+o.id+'-BC'+s.bc.id||currentStock.complete!==true||!Array.isArray(currentStock.documents)||currentStock.documents.length)return no('current_stock_unverified');
 if(!Array.isArray(labels)||!labels.length||labels.some(x=>!x.production||!x.bytes||!x.rawSha256||!x.tracking||x.error))return no('existing_label_unverified');
 const at=Date.parse(checkedAt);if(!Number.isFinite(at)||at>now||now-at>300000)return no('proof_expired');
 return {eligible:true,previousError:oldCycleDiagnostic,currentError:currentCycleDiagnostic,oldBcId:String(p.oldBcId),bcId:String(s.bc.id),blId:String(bl.id),checkedAt,businessCompleted:false,preparationStarted:false,providerWrites:0};
}
