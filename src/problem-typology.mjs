import {hasCompleteOrderDocuments} from './complete-order-documents.mjs';
import {isDeliveredOrder} from './delivered-order.mjs';
// Shared contract: labels come from the same compactProblems implementation as the UI.
export const WITHOUT_DIAGNOSTIC='Filtre problèmes sans diagnostic détaillé';
export function orderProblemLabels(order, compactProblems, inProblemFilter=false){
 if(isDeliveredOrder(order))return [];
 if(order.suspension?.problemDeferral?.active===true||hasCompleteOrderDocuments(order))return [];
 if(order.archived||order.suspension?.active===true||order.label_status==='cancelled'||order.tracking_status==='cancelled'||order.erp_live?.bc?.status==='cancelled'||order.suspension?.erplainCancellation?.status==='complete')return [];
 const labels=[...new Set(compactProblems(order).map(d=>d.label).filter(Boolean))];
 if(!labels.length&&inProblemFilter&&!order.label_manual_request_required&&!order.manual_label_request&&!order.temu_pdf_archive_note&&!order.open_bl_diagnostic_retired)labels.push(WITHOUT_DIAGNOSTIC);
 return labels;
}
export function selectProblemOrders(orders, selectedLabels, compactProblems, problemIds=[],activeOnly=false){
 const selected=new Set(selectedLabels), ids=new Set(problemIds),counts=new Map();
 const annotated=orders.map(order=>({order,labels:orderProblemLabels(order,compactProblems,ids.has(order.id))}));
 for(const {labels} of annotated)for(const label of labels)counts.set(label,(counts.get(label)||0)+1);
 const rows=annotated.filter(x=>(!activeOnly||x.labels.length>0)&&(!selected.size||x.labels.some(label=>selected.has(label)))).map(x=>x.order);
 return {rows,total:rows.length,problemTypes:[...counts].sort((a,b)=>a[0].localeCompare(b[0],'fr')).map(([label,count])=>({label,count}))};
}
export function paginateProblemOrders(result,page=1,pageSize=50){
 if(!Number.isInteger(pageSize)||pageSize<1||!Number.isInteger(page)||page<1)throw Error('Pagination invalide');
 const pages=Math.max(1,Math.ceil(result.total/pageSize));
 return {...result,rows:result.rows.slice((page-1)*pageSize,page*pageSize),page,pages};
}
