import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptCandidates,receiptWork} from '../src/receipt-candidates.mjs';
const receipts=[{id:1,label:'PRP259',status:'delivered',update_stock:true,line_items:[{quantity:1,variant:{id:42,sku:'SKU'},location:{id:1}}]}];
test('receipt fast admission retains source/mapped SKU, recorded variant and unknown snapshots',()=>{
 const orders=[{id:'source',skus:['SKU']},{id:'mapped',skus:['other','SKU']},{id:'variant',erp_live:{bc:{line_items:[{variant:{id:42,sku:'old'}}]}}},{id:'unknown',erp_live:{bc:{id:4}}},{id:'other',skus:['other'],erp_live:{bc:{line_items:[{variant:{id:99,sku:'other'}}]}}}];
 assert.deepEqual(receiptCandidates(receipts,orders).map(o=>o.id),['source','mapped','variant','unknown']);
});
test('warehouse view separates finished history, existing PDFs, actionable and blocked orders',()=>{
 assert.equal(receiptWork({labels:[{}],bls:[{status:'delivered'}]},{}),'history');
 assert.equal(receiptWork({labels:[{}],status:'blocked',bls:[{id:'b',label:'SHO',status:'in_preparation'}]},{}),'available');
 assert.equal(receiptWork({labels:[],status:'documents',canLabel:true},{}),'action');
 assert.equal(receiptWork({labels:[],status:'blocked'},{}),'blocked');
});

test('documents ready requires a BL and every label, never a label or completed item alone',()=>{
 assert.equal(receiptWork({labels:[{}],status:'eligible'},{}),'action');
 assert.equal(receiptWork({labels:[{}],status:'blocked',item:{state:'complete'}},{}),'blocked');
 assert.equal(receiptWork({labels:[],status:'blocked',bls:[{id:'b',label:'SHO',status:'ready_to_ship'}]},{}),'blocked');
 assert.equal(receiptWork({labels:[{}],status:'blocked',documentsComplete:false,bls:[{id:'b',label:'SHO',status:'ready_to_ship'}]},{}),'blocked');
 assert.equal(receiptWork({labels:[{}],status:'blocked',documentsComplete:true,currentBl:{id:'b',label:'SHO',status:'in_preparation'}},{}),'available');
});
