import {readSubstitutionAttempt} from './substitution-attempt.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';

export const interruptedPreviewErrors=[
 'Rapprocher d’abord le remplacement interrompu enregistré sur ce BC, avant de choisir un autre produit.',
 'Rapprocher d’abord le remplacement déjà demandé sur ce BC, avant de choisir un autre produit.'
];
export const equivalentPreviewRecheckMessage='Reprendre le remplacement : nouvelle vérification nécessaire';
function quantities(lines,read){
 const sum=new Map();
 for(const line of lines){const [sku,value]=read(line),quantity=Number(value);if(!sku||value==null||!Number.isFinite(quantity)||quantity<=0)return null;sum.set(sku,(sum.get(sku)||0)+quantity);}
 return JSON.stringify([...sum].sort());
}

// This proves only the local commit. A fresh preview still reads the complete
// provider BC and product; no saved confirmation or fingerprint is reused.
export function committedPreviewNeedsRecheck(order,preview,recorded,lines){
 if(preview?.action!=='equivalent-preview'||preview.status!=='review'||!interruptedPreviewErrors.includes(preview.error)||preview.payload?.confirmEquivalent===true||preview.payload?.substitutionAttempt)return false;
 if(!order||order.archived||order.partial_mode||cancellationBlock(order)||order.source_payload?.marketplacePendingCorrection||order.source_payload?.visibilityHold||order.resolution_pending_resume||order.erp_live?.bl?.id||order.erp_live?.stockDocument||/^(creating|publishing)/.test(order.erp_live?.phase||'')||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))return false;
 const body=preview.payload;
 if(body?.scope!=='order'||!body.sku||!body.replacementSku||body.sku===body.replacementSku||!['replaceQuantity','replacementQuantity'].every(k=>Number.isFinite(Number(body[k]))&&Number(body[k])>0)||recorded?.status!=='review'||recorded.payload?.scope!=='order'||!Array.isArray(lines)||!lines.length)return false;
 let attempt;try{attempt=readSubstitutionAttempt(recorded,order);}catch{return false;}
 if(attempt?.phase!=='local_committed'||attempt.permanent!==null||!attempt.completionResult||order.erp_live?.equivalentAttemptId!==attempt.requestId||body.sku===recorded.payload.sku||body.sku===recorded.payload.replacementSku)return false;
 const actual=quantities(lines,l=>[l.target_sku||l.source_sku,l.target_quantity??l.quantity]);
 const expected=Array.isArray(attempt.plan.expected)&&quantities(attempt.plan.expected,l=>[l.sku,l.quantity]);
 return actual!==null&&actual===expected&&lines.some(l=>(l.target_sku||l.source_sku)===body.sku);
}
