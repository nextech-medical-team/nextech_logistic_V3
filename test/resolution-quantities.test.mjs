import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolveReplacementLines} from '../src/resolution-quantities.mjs';

test('replacement dialog uses current mapped SKU and quantity rather than stale preparation values',async()=>{
 const source=await readFile(new URL('../public/problem-corrections.js',import.meta.url),'utf8');
 const start=source.indexOf('function equivalentCandidates(ctx)'),end=source.indexOf('function equivalentSelection(ctx,problem)',start);
 const context=vm.createContext({});vm.runInContext(source.slice(start,end),context);
 const line={source_sku:'SOURCE',quantity:20,target_sku:'OLD',target_quantity:3000,mapped_sku:'NEW',source_qty:1,target_qty:2};
 const candidates=lines=>JSON.parse(JSON.stringify(context.equivalentCandidates({order:{channel:'temu'},lines})));
 assert.deepEqual(candidates(resolveReplacementLines([line],'temu')),[{sku:'NEW',quantity:40,sources:['SOURCE']}]);
 assert.deepEqual(candidates(resolveReplacementLines([{...line,source_payload:{mappingScope:'order'}}],'temu')),[{sku:'OLD',quantity:3000,sources:['SOURCE']}]);
 const invalid=resolveReplacementLines([{...line,source_qty:0}],'temu');assert.match(invalid[0].replacement_quantity_error,/Conversion/);assert.deepEqual(candidates(invalid),[]);
 assert.deepEqual(candidates(resolveReplacementLines([line,{...line,quantity:5}],'temu')),[{sku:'NEW',quantity:50,sources:['SOURCE','SOURCE']}]);
});
