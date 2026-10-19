import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryTransaction} from '../src/recovery-transaction.mjs';
import {retryDecision} from '../src/erp-transient-policy.mjs';
test('deadlocked local commit rolls back and retries; external work is performed once',async()=>{
 let providerReads=0,commits=0;const pauses=[];
 const snapshot=await(async()=>{providerReads++;return {bc:'1'};})();
 const db={transaction:async fn=>{commits++;const staged=[];const value=await fn({query:async sql=>staged.push(sql)});if(commits===1)throw Object.assign(Error('transaction aborted'),{code:'40P01'});return value;}};
 const result=await recoveryTransaction(db,async tx=>{await tx.query('persist verified '+snapshot.bc);return 'pending';},{pause:async ms=>pauses.push(ms)});
 assert.equal(result,'pending');assert.equal(providerReads,1);assert.equal(commits,2);assert.deepEqual(pauses,[25]);
});
test('retry cap and non-concurrency failures propagate without endless replay',async()=>{
 for(const code of ['40P01','40001','23505']){let attempts=0;await assert.rejects(recoveryTransaction({transaction:async()=>{attempts++;throw Object.assign(Error('failed'),{code});}},()=>{}, {pause:async()=>{}}),{code});assert.equal(attempts,code==='23505'?1:3);}
});
test('SQLSTATE-only deadlock diagnostics enter bounded reconciliation',()=>{
 const o={erp_live:{phase:'bc_created',bc:{id:'1'}},source_payload:{}};
 assert.equal(retryDecision(o,'SQLSTATE[40P01]',new Date(Date.now()-60000).toISOString()),true);
 assert.equal(retryDecision({...o,suspension:{active:true}},'SQLSTATE[40P01]',new Date(Date.now()-60000).toISOString()),false);
});
