import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {configureShipmentLocks,withShipmentLock} from '../src/shipment-lock.mjs';

test('Erplain entry points no longer acquire a workflow-wide mutex',async()=>{
 for(const name of ['equivalence-import','erplain-interrupted','problem-resolution','erplain-live-workflow']){
  const source=await readFile(new URL('../src/'+name+'.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/['"]erplain-live-workflow['"]/ ,name);
  assert.match(source,/withShipmentLock/ ,name+' retains stock protection');
 }
 const workflow=await readFile(new URL('../src/erplain-live-workflow.mjs',import.meta.url),'utf8');
 assert.match(workflow,/if\(running\)return;running=true/);
 assert.match(workflow,/FOR UPDATE SKIP LOCKED/);
 const resolutions=await readFile(new URL('../src/problem-resolution.mjs',import.meta.url),'utf8');
 assert.match(resolutions,/resolution_order_busy/);
});

test('stock writes stay exclusive and nested locks are reentrant after removal',async()=>{
 const events=[],dbKeys=[];
 configureShipmentLocks({withLocks:async(keys,fn)=>{dbKeys.push(keys);return fn();}});
 let entered,release;
 const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 try{
  const first=withShipmentLock(async()=>{events.push('first');entered();await withShipmentLock(async()=>events.push('nested'));await hold;events.push('released');});
  await started;
  const second=withShipmentLock(async()=>events.push('second'));
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(events,['first','nested']);
  release();await Promise.all([first,second]);
  assert.deepEqual(events,['first','nested','released','second']);
  assert.deepEqual(dbKeys,[['stock-mutations'],['stock-mutations']]);
 }finally{release?.();configureShipmentLocks(null);}
});
