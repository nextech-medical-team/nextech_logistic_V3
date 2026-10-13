import {readSubstitutionAttempt} from './substitution-attempt.mjs';
import {verifySourceCommercialTotals,withSourceCommercialGuard} from './bc-pricing.mjs';

export function importBcAmounts(bc,requestId){
 return {version:1,bcId:String(bc.id),requestId,total:bc.total,tax:bc.line_items.reduce((n,l)=>n+Number(l.tax_amount),0),currency:bc.currency?.label};
}
export function preservedImportAmounts(order){
 const proof=order.erp_live?.importBcAmounts;
 if(!proof)return null;
 if(proof.version!==1||proof.bcId!==String(order.erp_live.bc?.id)||proof.requestId!==order.erp_live.equivalentAttemptId)throw Error('BC importé · Référence commerciale à rapprocher');
 return proof;
}
export function verifyImportBcAmounts(bc,proof){
 if(String(bc?.id)!==proof.bcId)throw Error('BC importé · Identité différente');
 const confirmed=verifySourceCommercialTotals(bc,proof);
 const cents=v=>Math.round(Number(v)*100);
 if(cents(confirmed.total)!==cents(proof.total)||cents(confirmed.tax)!==cents(proof.tax))throw Error('BC importé · Montants modifiés depuis le remplacement');
 return confirmed;
}
// Recover the commercial basis of imports committed before this proof existed.
// Read only: no uncertain mutation is replayed and no platform price is adopted.
export async function restoreImportBcAmounts(db,order,lines){
 if(preservedImportAmounts(order)||!order.erp_live?.equivalentAttemptId)return;
 const failed=(await db.query("SELECT id,status,payload FROM resolution_jobs WHERE order_id=$1 AND request_id=$2 AND action='replace-equivalent'",[order.id,order.erp_live.equivalentAttemptId])).rows[0];
 if(!failed?.payload?.importRow||!failed.payload.substitutionAttempt)return;
 const attempt=readSubstitutionAttempt({...failed,status:failed.status==='complete'?'review':failed.status},order);
 if(attempt?.phase!=='local_committed'||!attempt.completionResult)return;
 const signature=rows=>JSON.stringify(rows.map(l=>[l.sku,Number(l.quantity)]).sort());
 if(signature(lines.map(l=>({sku:l.target_sku||l.source_sku,quantity:l.target_quantity??l.quantity})))!==signature(attempt.plan.expected))throw Error('BC importé · Lignes locales à rapprocher');
 order.erp_live.importBcAmounts=importBcAmounts(attempt.plan.commercialBefore,attempt.requestId);
}
export async function withImportCommercialGuard(api,order,source,fn){
 const proof=preservedImportAmounts(order);
 if(!proof)return withSourceCommercialGuard(api,order.erp_live.bc.id,source,fn);
 const {Order:bc}=await api.request('query V3ImportBeforeStock($id:ID!){Order(id:$id){id total currency{label} line_items{tax_amount}}}',{id:proof.bcId});
 verifyImportBcAmounts(bc,proof);return fn();
}
