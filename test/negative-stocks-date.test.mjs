import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/review.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('// Date sorting helpers:'),source.indexOf('// End date sorting helpers.'));
const context=vm.createContext({Date,Number});vm.runInContext(helpers,context);
test('date sort uses chronological order in both directions and keeps unknown dates last',()=>{
 const rows=[{bcDate:'2026-10-01',bcLabel:'B',sku:'1'},{bcDate:null,bcLabel:'A',sku:'1'},{bcDate:'2026-09-30',bcLabel:'C',sku:'1'},{bcDate:'2026-10-15',bcLabel:'D',sku:'1'},{bcDate:'invalid',bcLabel:'Z',sku:'1'}];
 assert.deepEqual([...rows].sort((a,b)=>context.compareNegativeStockDates(a,b,-1)).map(row=>row.bcLabel),['D','B','C','A','Z']);
 assert.deepEqual([...rows].sort((a,b)=>context.compareNegativeStockDates(a,b,1)).map(row=>row.bcLabel),['C','B','D','A','Z']);
});
test('BC dates are displayed as French calendar dates and absent dates remain unknown',()=>{
 assert.equal(context.formatNegativeStockDate('2026-10-15'),'15/10/2026');
 for(const value of [null,undefined,'','invalid'])assert.equal(context.formatNegativeStockDate(value),'Non renseigné');
});
