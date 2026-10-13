import test from 'node:test';
import assert from 'node:assert/strict';
import {importBcAmounts,preservedImportAmounts,verifyImportBcAmounts,restoreImportBcAmounts,withImportCommercialGuard} from '../src/import-bc-commercial.mjs';
import {startSubstitutionAttempt} from '../src/substitution-attempt.mjs';
const bc={id:'11',total:17.48,currency:{label:'EUR'},update_stock:false,line_items:[{tax_amount:2.91}]};
const order=()=>({id:'o',channel:'temu',erp_live:{bc:{id:'11'},equivalentAttemptId:'r',importBcAmounts:importBcAmounts(bc,'r')}});
test('resume keeps BC amounts despite different marketplace revenue',()=>{
 const o=order();o.erp_live.pricing={total:19.17};
 assert.equal(verifyImportBcAmounts(bc,preservedImportAmounts(o)).total,17.48);
 for(const patch of [{id:'12'},{total:17.49},{currency:{label:'USD'}},{line_items:[{tax_amount:2.92}]},{line_items:[{}]}])assert.throws(()=>verifyImportBcAmounts({...bc,...patch},o.erp_live.importBcAmounts));
 o.erp_live.equivalentAttemptId='other';assert.throws(()=>preservedImportAmounts(o));
});
test('stock guard blocks changed BC amounts before continuation',async()=>{
 let continued=0;const o=order(),api={request:async()=>({Order:bc})};
 await withImportCommercialGuard(api,o,null,async()=>continued++);assert.equal(continued,1);
 api.request=async()=>({Order:{...bc,total:17.49}});
 await assert.rejects(withImportCommercialGuard(api,o,null,async()=>continued++));assert.equal(continued,1);
});
test('recover old committed import basis without recovering uncertain writes',async()=>{
 const o=order();delete o.erp_live.importBcAmounts;
 const b={id:'o',requestId:'r',confirmEquivalent:true,previewFingerprint:'f',sku:'A',replacementSku:'B',replaceQuantity:400,replacementQuantity:400,importRow:{batchId:'batch',line:2}};
 const plan={previewFingerprint:'f',bcId:'11',commercialBefore:bc,originalSku:'A',replacementSku:'B',replaceQuantity:400,replacementQuantity:400,expected:[{sku:'B',quantity:400}]};
 let attempt;await startSubstitutionAttempt({query:async(sql,p)=>{attempt=JSON.parse(p[2]);return {rows:[{id:'job'}]};}},o,b,plan,null);
 const job={status:'review',payload:{...b,substitutionAttempt:{...attempt,phase:'local_committed',completionResult:{erpOnly:true}}}};
 const db={query:async()=>({rows:[job]})},lines=[{target_sku:'B',target_quantity:400}];
 await restoreImportBcAmounts(db,o,lines);assert.equal(preservedImportAmounts(o).total,17.48);
 delete o.erp_live.importBcAmounts;
 await assert.rejects(restoreImportBcAmounts(db,o,[{target_sku:'B',target_quantity:399}]),/Lignes locales/);
 job.payload.substitutionAttempt.phase='mutation_started';await restoreImportBcAmounts(db,o,lines);assert.equal(preservedImportAmounts(o),null);
 job.payload.substitutionAttempt.phase='local_committed';job.status='complete';await restoreImportBcAmounts(db,o,lines);assert.equal(preservedImportAmounts(o).total,17.48);
});
