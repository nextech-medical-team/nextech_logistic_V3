import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptAnalysis} from '../src/receipt-analysis.mjs';
import {receiptOutcome} from '../src/receipt-outcome.mjs';

test('resume retains successful reads, retries only missing reads and expires old stock',async()=>{
 let checkpoint={},clock=1000,calls=[],fail=true;const api={verify:async()=>{},request:async q=>{calls.push(q);if(q==='query Missing'&&fail)throw Error('429');return {value:q};}};
 const options={now:()=>clock,save:async c=>{checkpoint=structuredClone(c);}};
 const work=async reader=>{await reader.verify();await reader.request('query Receipt');return reader.request('query Missing');};
 await assert.rejects(receiptAnalysis(api,work,options),/429/);fail=false;
 await receiptAnalysis(api,work,{...options,checkpoint});assert.deepEqual(calls,['query Receipt','query Missing','query Missing']);
 clock+=120001;await receiptAnalysis(api,work,{...options,checkpoint});assert.equal(calls.filter(q=>q==='query Receipt').length,2);
});
test('bounded reader returns even if provider hangs; late result cannot save or report',async()=>{
 let release,saved=0,reports=0;const pending=new Promise(r=>release=r),api={request:()=>pending};
 await assert.rejects(receiptAnalysis(api,r=>r.request('query Slow'),{maxMs:15,now:()=>0,save:async()=>saved++,progress:async()=>reports++}),/délai/);
 release({value:1});await new Promise(r=>setTimeout(r,5));assert.equal(saved,0);assert.equal(reports,1);
});
test('analysis cannot execute mutations or reuse mutated cached response',async()=>{
 const api={request:async()=>({rows:[]})};let checkpoint={};
 await assert.rejects(receiptAnalysis(api,r=>r.request('mutation Buy')),/lectures/);
 await receiptAnalysis(api,r=>r.request('query Read'),{save:async c=>checkpoint=structuredClone(c)});
 await receiptAnalysis(api,async r=>{const x=await r.request('query Read');x.rows.push(1);const y=await r.request('query Read');assert.equal(y.rows.length,0);},{checkpoint});
});
test('outcome separates new completions, existing, missing PDF, missing BL and cancellations',()=>{
 const base={currentBl:{id:'b',label:'SHO',status:'in_preparation'},labels:[{name:'PDF',url:'/pdf'}],documentsComplete:true};
 const rows=[{...base,id:'new',item:{state:'complete'}},{...base,id:'old'},{...base,id:'missing',documentsComplete:false,item:{state:'complete'},reason:'Colis incomplet'},{id:'noBL',labels:[]},{...base,id:'cancelled',work:'history'}];
 const b=receiptOutcome({plan:{coverage:{complete:false}}},rows);assert.equal(b.complete,false);assert.equal(b.finalized.length,1);assert.equal(b.existing.length,1);assert.equal(b.unfinished.length,2);assert.equal(b.excluded.length,1);assert.match(b.unfinished[0].stage,/tous les colis/);assert.equal(b.unfinished[1].stage,'BL non disponible');
});
