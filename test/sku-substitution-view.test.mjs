import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {attachSkuSubstitutions} from '../src/sku-substitution-view.mjs';

test('SKU arrows require a successful recorded substitution, never just a mapping or pending equivalent',async()=>{
 const ui=vm.createContext({});vm.runInContext(await readFile(new URL('../public/diagnostics.js',import.meta.url),'utf8'),ui);
 const rows=[{id:'applied',channel:'temu'},{id:'ordinary',channel:'temu',pending_equivalent:{sku:'SOURCE',replacementSku:'NEW'},sku_lines:[{sku:'NEW',source_sku:'SOURCE',quantity:20}]}];
 const db={async query(sql,args){assert.match(sql,/action='order.product_substituted'/);assert.deepEqual(args,[['applied','ordinary']]);return {rows:[{detail:{orderId:'applied',originalSku:'OLD',replacementSku:'NEW',replaceQuantity:10,replacementQuantity:20}}]};}};
 await attachSkuSubstitutions(db,rows);
 assert.equal(ui.skuLineText(rows[0],{sku:'NEW',quantity:20}),'OLD (10) → NEW (20)');
 assert.equal(ui.skuLineText(rows[1],{sku:'NEW',source_sku:'SOURCE',quantity:20}),'NEW (20)');
 assert.equal(ui.skuLineText(rows[0],{sku:'UNRELATED',quantity:5}),'UNRELATED (5)');
 assert.equal(ui.skuLineText(rows[0],{sku:'NEW',quantity:25}),'OLD (10) → NEW (20) · Total NEW (25)');
 assert.equal(ui.skuLineText(rows[0],{sku:'OLD',quantity:3}),'OLD (3)');
 const duplicateLines=[{sku:'NEW',quantity:5},{sku:'NEW',quantity:20},{sku:'OLD',quantity:3}];
 assert.deepEqual(duplicateLines.map((l,i)=>ui.skuColumnLineText(rows[0],l,i,duplicateLines)).filter(Boolean),['OLD (10) → NEW (20) · Total NEW (25)','OLD (3)']);
});
