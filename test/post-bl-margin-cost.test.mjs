import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedTemuMarginCost} from '../src/post-bl-margin-cost.mjs';
const profiles=[{sku_temu:'OLD',sku_id:'old',sku_erplain:'ERP'},{sku_temu:'NEW',sku_id:'new',sku_erplain:'REPLACEMENT'}];
const adapter={find:l=>({cost:{mapping:2,unit:l.sku==='NEW'?4:3,supplierTransport:1,weight:.5,vat:.2}})};
test('cost uses the prepared SKU and ratio even when the global mapping differs',()=>{
 const input={profiles,line:{target_sku:'ERP',quantity:2,target_quantity:10},orderLine:{sku:'OLD',skuId:'old'},adapter};
 const before=JSON.stringify(input),r=preparedTemuMarginCost(input);
 assert.equal(r.cost.mapping,5);assert.equal(r.cost.unit,3);assert.equal(r.cost.supplierTransport,2.5);assert.equal(r.cost.weight,1.25);assert.equal(JSON.stringify(input),before);
 const replaced=preparedTemuMarginCost({...input,line:{...input.line,target_sku:'REPLACEMENT'}});
 assert.equal(replaced.cost.unit,4);assert.equal(replaced.cost.mapping,5);
});
test('missing or ambiguous prices stay unknown; no fabricated positive margin',()=>{
 const input={profiles,line:{target_sku:'MISSING',quantity:2,target_quantity:10},orderLine:{sku:'OLD',skuId:'old'},adapter};
 assert.match(preparedTemuMarginCost(input).error,/absent ou ambigu/);
 assert.match(preparedTemuMarginCost({...input,line:{...input.line,target_sku:'ERP'},profiles:[...profiles,{sku_temu:'ANOTHER',sku_id:'another',sku_erplain:'ERP'}],orderLine:{sku:'unrelated'}}).error,/ambigu/);
 assert.ok(preparedTemuMarginCost({...input,line:{...input.line,target_sku:'ERP',quantity:0}}).error);
});
