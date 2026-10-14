import test from 'node:test';import assert from 'node:assert/strict';
import {orderLocalTransaction} from '../src/order-local-transaction.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(onQuery=()=>{}){const calls=[];let released=0,destroyed=false;return {calls,get released(){return released;},get destroyed(){return destroyed;},client:{query:async q=>{calls.push(q.text);return onQuery(q)||{rows:[]};},release:()=>released++,connection:{stream:{destroy:()=>destroyed=true}}}};}
test('committed local transaction returns result and metrics and releases exactly once',async()=>{
 const f=fixture(),r=await orderLocalTransaction({connect:async()=>f.client},async tx=>{await tx.query('UPDATE local_fixture');return 'saved';});
 assert.equal(r.result,'saved');assert.ok(r.timings.totalMs>=0);assert.ok(f.calls.includes('COMMIT'));assert.equal(f.released,1);
});
test('an expired checkout never runs a late change and releases the late client',async()=>{
 const f=fixture();let deliver,changed=false;const pool={connect:()=>new Promise(r=>deliver=r)};
 await assert.rejects(()=>orderLocalTransaction(pool,async()=>changed=true,{budgetMs:20}),e=>e.status===423);
 deliver(f.client);await sleep(1);assert.equal(changed,false);assert.equal(f.released,1);assert.deepEqual(f.calls,[]);
});
test('local deadline rolls back instead of committing delayed work',async()=>{
 const f=fixture();await assert.rejects(()=>orderLocalTransaction({connect:async()=>f.client},async()=>{await sleep(40);return 'late';},{budgetMs:25}),e=>e.code==='LOCAL_ORDER_BUSY');
 assert.ok(f.calls.includes('ROLLBACK'));assert.ok(!f.calls.includes('COMMIT'));assert.equal(f.released,1);
});
test('row contention is refused and rollback preserves the database',async()=>{
 const f=fixture(q=>{if(q.text==='SELECT held')throw Object.assign(Error('locked'),{code:'55P03'});});
 await assert.rejects(()=>orderLocalTransaction({connect:async()=>f.client},tx=>tx.query('SELECT held')),e=>e.status===423);
 assert.ok(f.calls.includes('ROLLBACK'));assert.ok(!f.calls.includes('COMMIT'));
});
test('an uncertain COMMIT destroys the connection and is never reported as not saved',async()=>{
 const f=fixture(q=>{if(q.text==='COMMIT')throw Error('Query read timeout');});
 await assert.rejects(()=>orderLocalTransaction({connect:async()=>f.client},async()=>({saved:true})),e=>e.code==='LOCAL_ORDER_UNCERTAIN'&&e.status===503);
 assert.equal(f.destroyed,true);assert.equal(f.released,1);assert.ok(!f.calls.includes('ROLLBACK'));
});
