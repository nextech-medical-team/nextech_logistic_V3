import test from 'node:test';
import assert from 'node:assert/strict';
import {carrierLocalTransaction} from '../src/carrier-local-transaction.mjs';
test('rolled-back deadlocks retry local SQL at most three times',async()=>{
 let calls=0;const delays=[];
 const db={transaction:async fn=>{calls++;if(calls<3)throw Object.assign(Error('deadlock'),{code:'40P01'});return fn();}};
 assert.equal(await carrierLocalTransaction(db,()=>42,{sleep:async ms=>delays.push(ms)}),42);
 assert.equal(calls,3);assert.deepEqual(delays,[25,50]);
});
test('permanent SQL errors and exhausted retries propagate; external work stays outside',async()=>{
 for(const [code,expected] of [['23505',1],['40P01',3],['40001',3]]){
  let calls=0,external=0;const error=Object.assign(Error(code),{code});
  await assert.rejects(async()=>{await carrierLocalTransaction({transaction:async()=>{calls++;throw error;}},()=>{}, {sleep:async()=>{}});external++;},e=>e===error);
  assert.equal(calls,expected);assert.equal(external,0);
 }
});
