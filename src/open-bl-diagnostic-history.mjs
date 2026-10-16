import {visibleOrderBls} from './bl-identity.mjs';
// Projection only: a dated preparation failure does not describe the current BL list.
export const noPendingBlReason='Aucun BL en attente : les quantités déjà expédiées ou livrées ne sont pas récupérées';
export function projectOpenBlDiagnosticHistory(order){
 if(order.partial_mode||order.archived||order.suspension?.active||order.source_payload?.erplainImported!==true||order.source_payload?.account!=='live'||order.erp_live?.bc?.status!=='active')return;
 const open=visibleOrderBls(order).filter(bl=>['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status));
 if(!open.length)return;
 const sources=[[order,'resolution_error'],[order,'issue'],[order.erp_live_job,'error'],...(order.resolution_actions||[]).map(job=>[job,'error'])];
 const history=order.open_bl_diagnostic_history||[];
 for(const [target,key] of sources){
  if(target?.[key]!==noPendingBlReason)continue;
  if(!history.some(item=>item.reason===noPendingBlReason))history.push({reason:noPendingBlReason,openBlIds:open.map(bl=>String(bl.id))});
  target[key]=null;
 }
 if(history.length){
  order.open_bl_diagnostic_history=history;
  order.open_bl_diagnostic_retired=![order.erp_live_job,order.carrier_job,order.temu_job].some(job=>job&&['failed','review','uncertain'].includes(job.status)&&!job.error);
 }
}
