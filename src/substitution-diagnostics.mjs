// A confirmed replacement retires only shortages of products removed from the
// BC. This is a display projection, never a stock/readiness or replay authority.
const quantity=v=>v!=null&&typeof v!=='boolean'&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>0;
const totals=rows=>{
 if(!Array.isArray(rows)||!rows.length)return null;
 const result=new Map();
 for(const row of rows){if(typeof row.sku!=='string'||!row.sku.trim()||!quantity(row.quantity))return null;result.set(row.sku,(result.get(row.sku)||0)+Number(row.quantity));}
 return result;
};
export function replacementDiagnosticProof(order){
 const p=order.erp_live||{},stamp=Date.parse(p.equivalentRefreshedAt),source=p.documentSource;
 if(!p.bc?.id||!p.equivalentAttemptId||!Number.isFinite(stamp)||stamp>Date.now()||!Number.isFinite(Date.parse(source?.checkedAt))||Date.parse(source.checkedAt)<stamp)return null;
 const current=totals(source.lines),selected=totals(p.equivalentItems?.map(l=>({sku:l.description,quantity:l.quantity})));
 if(!current||!selected||current.size!==selected.size||[...current].some(([sku,q])=>!selected.has(sku)||Math.abs(q-selected.get(sku))>1e-6))return null;
 const bc=totals(p.bc.line_items?.filter(l=>l.variant).map(l=>({sku:l.variant.sku,quantity:l.quantity})));
 const matches=bc&&bc.size===current.size&&[...current].every(([sku,q])=>bc.has(sku)&&Math.abs(q-bc.get(sku))<=1e-6);
 // Legacy commits kept the old BC snapshot. Admit that display repair only
 // while preparation is pending, with no new ERP failure. A newer divergent
 // BC or failed preparation must retain its diagnostic for reconciliation.
 if(!matches&&(p.substitutionDiagnostics||!['pending','processing'].includes(order.erp_live_job?.status)||order.erp_live_job.error))return null;
 const originals=[...(p.equivalentOriginalLines||[]).map(l=>l.target_sku||l.source_sku),...(p.bc.line_items||[]).map(l=>l.variant?.sku),...(String(p.substitutionDiagnostics?.bcId)===String(p.bc.id)?p.substitutionDiagnostics.retiredSkus||[]:[])];
 const retired=new Set(originals.filter(sku=>typeof sku==='string'&&sku&&!current.has(sku)));
 return {bcId:String(p.bc.id),attemptId:p.equivalentAttemptId,checkedAt:p.equivalentRefreshedAt,current,retired};
}
export function supersededStockReason(reason,proof){
 if(typeof reason!=='string'||!proof)return false;
 const text=reason.replace(/^Préparation V3 à vérifier · /,'');
 const match=/^BL bloqué [—-] stock insuffisant : (.+)$/.exec(text);if(!match)return false;
 return match[1].split(' ; ').every(part=>{
  const shortage=/^([^:;]+) : [\d.]+ nécessaires, [\d.]+ utilisables, manque [\d.]+$/.exec(part);
  return shortage&&proof.retired.has(shortage[1])&&!proof.current.has(shortage[1]);
 });
}
export function projectSubstitutionDiagnostics(order){
 const proof=replacementDiagnosticProof(order);if(!proof)return order;
 const history=[];
 for(const [target,key] of [[order,'issue'],[order,'resolution_error'],[order.erp_live_job,'error'],...(order.resolution_actions||[]).map(j=>[j,'error'])]){
  if(target&&supersededStockReason(target[key],proof)){history.push({reason:target[key],bcId:proof.bcId,attemptId:proof.attemptId,supersededAt:proof.checkedAt});target[key]=null;}
 }
 const stock=order.erp_live.stockIncidentRecheck;
 if(stock&&supersededStockReason(stock.currentError,proof)){
  history.push({reason:stock.currentError,bcId:proof.bcId,attemptId:proof.attemptId,supersededAt:proof.checkedAt});
  order.erp_live={...order.erp_live,stockIncidentRecheck:{...stock,status:'superseded',currentError:null}};
 }
 if(history.length)order.substitution_diagnostic_history=history;
 if(['pending','processing'].includes(order.erp_live_job?.status)&&!order.erp_live_job.error&&!order.archived&&!order.suspension?.active&&!order.partial_mode&&!order.resolution_pending_resume&&!['cancelled','shipped','delivered','in_transit'].includes(order.tracking_status)&&order.label_status!=='cancelled'){
  order.replacement_preparation={status:order.erp_live_job.status,products:[...proof.current].map(([sku,quantity])=>({sku,quantity})),message:order.erp_live_job.status==='processing'?'Remplacement enregistré · préparation en cours':'Remplacement enregistré · préparation en attente'};
 }
 return order;
}
