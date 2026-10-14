import {restoreImportBcAmounts} from '../src/import-bc-commercial.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mappingSelectionFingerprint,currentMappingFingerprint} from '../src/current-mapping-line.mjs';
import {usesRecordedBc} from '../src/existing-bc-execution.mjs';
const source=readFileSync(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
const start=source.indexOf('   const valid=[];'),end=source.indexOf('   working=valid;',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const prepare=new AsyncFunction('working','db','refreshManualOrder','api','fail','usesRecordedBc','readRecordedBc','save','restoreImportBcAmounts',source.slice(start,end)+'return valid;');
const lines=[{id:'line',source_sku:'original',quantity:1000,target_sku:'replacement',target_quantity:1000,source_payload:{mappingScope:'order'}}];
for(const kind of ['equivalent','imported'])test(kind+' preparation retains source mapping snapshot through BL final validation',async()=>{
 const o={id:'test',channel:'tender',source_payload:kind==='imported'?{erplainImported:true,account:'live'}:{},erp_live:{bc:{id:1},[kind==='imported'?'importedItems':'equivalentItems']:[{variant:{id:2},quantity:1000}]}};
 let reads=0;const db={query:async sql=>{assert.match(sql,/^SELECT l\.\*/);reads++;return {rows:structuredClone(lines)};}};
 const valid=await prepare([o],db,async()=>{}, {},async(_o,e)=>{throw e;},usesRecordedBc,async()=>({items:[{variant:{id:2},quantity:1000}],bc:{id:1,status:'active'},pricing:{status:'observed'}}),async()=>{},restoreImportBcAmounts);
 assert.equal(valid.length,1);assert.equal(reads,1);assert.deepEqual(o.selectedSourceLines,lines);
 const selected=mappingSelectionFingerprint(o.selectedSourceLines,o.channel);
 assert.equal(await currentMappingFingerprint(db,o),selected);
 assert.deepEqual(o.items,[{variant:{id:2},quantity:1000}]);
});
test('mapping fingerprint detects changes for legacy non-marketplace preparation',async()=>{
 const before=mappingSelectionFingerprint(lines,'temu'),changed=structuredClone(lines);changed[0].target_quantity=900;
 assert.notEqual(mappingSelectionFingerprint(changed,'temu'),before);
});
for(const channel of ['temu','amazon','shopify'])test(channel+' recorded BC overrides old equivalent selection and preserves source snapshot without comparing it',async()=>{
 const o={id:'recorded',channel,source_payload:{},erp_live:{bc:{id:1},equivalentItems:[{variant:{id:2},quantity:1000}]}};
 const actual={bc:{id:1,currency:{label:'EUR'}},items:[{variant:{id:3},quantity:2}],pricing:{confirmed:{total:12,authority:'recorded_erplain_bc'}}};let saved=0,read=0;
 const db={query:async()=>({rows:structuredClone(lines)})};
 const valid=await prepare([o],db,async()=>{throw Error('Unexpected imported read');},{},async(_o,e)=>{throw e;},usesRecordedBc,async()=>{read++;return structuredClone(actual);},async()=>{saved++;});
 assert.equal(valid.length,1);assert.equal(read,1);assert.equal(saved,1);assert.deepEqual(o.items,actual.items);assert.deepEqual(o.selectedSourceLines,lines);assert.deepEqual(o.erp_live.pricing,actual.pricing);
});
