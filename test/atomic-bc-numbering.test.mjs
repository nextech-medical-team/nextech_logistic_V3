import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {numberedNewBcInput} from '../src/bc-numbering.mjs';
const source=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const body=source.slice(source.indexOf(' async function batchMutation('),source.indexOf(' async function run('));
const build=new AsyncFunction('db','api','withSalesBcPublicationLock','assertNewBcStock','mutationBlock','activeBcOnlyOrderId','save','fail','assertLiveCapacity','numberedNewBcInput','customerCreationStarted','customerCreationFailed',body+'return batchMutation;');
async function fixture(mode='ok'){
 let number=16088,tail=Promise.resolve(),locked=false;const calls=[],saved=[],failures=[],documents=[];
 const lock=fn=>{const next=tail.then(async()=>{locked=true;try{return await fn();}finally{locked=false;}});tail=next.catch(()=>{});return next;};
 const api={request:async(q,v)=>{
  calls.push({q,v});assert.equal(locked,true);
  if(q.includes('V3LiveCapacity'))return {Orders:{paginatorInfo:{total:10}}};
  if(q.includes('DocumentNumberingContext'))return {DocumentNumberingContext:{preview:'C00'+number,manual_override_allowed_effective:true}};
  assert.match(q,/^mutation V3Batch/);const input=v.p0;assert.equal(input.status,'active');assert.equal(input.update_stock,true);assert.match(input.label,/^C\d+$/);
  if(mode==='collision')throw Error('label already in use');
  const bc={id:100+documents.length,label:input.label,status:'active',update_stock:true};documents.push(bc);number++;
  if(mode==='lost-response')throw Error('ECONNRESET');
  return {p0:mode==='incomplete'?{id:bc.id}:bc};
 }};
 const db={query:async(q,v)=>q.startsWith('SELECT * FROM orders')?{rows:[{id:v[0]}]}:{rows:[]}};
 const save=async o=>saved.push(structuredClone(o));const fail=async(o,e)=>failures.push(e.message);
 const batch=await build(db,api,lock,async()=>{assert.equal(locked,true);if(mode==='shortage')throw Error('stock insuffisant');},()=>null,null,save,fail,()=>({limit:100000}),numberedNewBcInput,()=>({}),()=>({}));
 const order=id=>({id,erp_live:{customer:{id:1}}});const input=o=>({status:'unpublished',update_stock:true,dated_at:'2026-10-18',external_reference:o.id,internal_notes:'[V3:'+o.id+']',line_items:[{quantity:1}]});
 const run=orders=>batch(orders,'creating_bc','bc','OrderInput','CreateOrder',input,'id label status update_stock');
 return {run,order,calls,saved,failures,documents};
}
for(const channel of ['amazon','temu','shopify','tender','relay','samples','rakuten'])test(channel+': one atomic BC creation, no intermediate draft/update',async()=>{
 const f=await fixture(),o={...f.order(channel),channel};await f.run([o]);assert.equal(o.erp_live.bc.status,'active');assert.equal(f.calls.filter(c=>c.q.startsWith('mutation')).length,1);assert.equal(f.calls.length,3);assert.equal(f.failures.length,0);assert.equal(f.saved[0].erp_live.phase,'creating_bc');assert.equal(f.saved.at(-1).erp_live.bc.id,100);
});
test('concurrent creation uses distinct official numbers under the existing lock',async()=>{const f=await fixture();await Promise.all([f.run([f.order('a')]),f.run([f.order('b')])]);assert.equal(new Set(f.documents.map(d=>d.label)).size,2);});
for(const mode of ['lost-response','collision','shortage','incomplete'])test(mode+': no automatic CreateOrder replay',async()=>{const f=await fixture(mode),o=f.order('a');await f.run([o]);assert.equal(f.failures.length,1);assert.equal(f.calls.filter(c=>c.q.startsWith('mutation')).length,mode==='shortage'?0:1);if(mode==='incomplete')assert.equal(o.erp_live.bc.id,100);});
test('unverified sequence or changed stock policy produces no creation',async()=>{let calls=0;const api={request:async()=>{calls++;return {DocumentNumberingContext:{preview:'C123',manual_override_allowed_effective:false}};}};await assert.rejects(numberedNewBcInput(api,{status:'unpublished',update_stock:true}));await assert.rejects(numberedNewBcInput(api,{status:'unpublished',update_stock:false}));assert.equal(calls,1);});
test('draft number display never presents a provisional label as official',async()=>{const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const scope={};vm.createContext(scope);vm.runInContext(app.slice(0,app.indexOf('\n')),scope);assert.equal(scope.bcReferenceText({erp_live:{bc:{id:1949881,label:'C0016088',status:'unpublished'}}}),'Brouillon #1949881');assert.equal(scope.bcReferenceText({erp_live:{bc:{id:1949882,label:'C0016088',status:'active'}}}),'C0016088');assert.equal(scope.bcReferenceText({}),'—');});
