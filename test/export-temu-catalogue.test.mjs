import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,categoryParts,collectProducts} from '../scripts/export-temu-catalogue.mjs';
test('pagination deduplicates overlapping goods while preserving distinct products',()=>{
 const rows=collectProducts([{goodsList:[{goodsId:123,name:'old'},{goodsId:124}]},{goodsList:[{goodsId:123,name:'fresh'},{goodsId:125}]}]);
 assert.equal(rows.length,3);assert.equal(rows.find(r=>r.goodsId===123).name,'fresh');
 assert.throws(()=>collectProducts([{goodsList:null}]),/Liste produits/);
 assert.throws(()=>collectProducts([{goodsList:[{}]}]),/Identifiant/);
});
test('category hierarchy preserves all levels and literal slashes in names',()=>{
 assert.deepEqual(categoryParts('Industrial & Scientific / Diagnostics & Screening / Stethoscopes'),['Industrial & Scientific','Diagnostics & Screening','Stethoscopes']);
 assert.deepEqual(categoryParts('Health / First Aid/Trauma'),['Health','First Aid/Trauma']);
 assert.deepEqual(categoryParts(null),[]);
});
test('CSV preserves quotes and neutralises spreadsheet formulas',()=>{
 assert.equal(csvCell('a;"b"'),'"a;""b"""');
 assert.equal(csvCell('=HYPERLINK("test")'),'"\'=HYPERLINK(""test"")"');
 assert.equal(csvCell('609371216046692'),'"609371216046692"');
});
