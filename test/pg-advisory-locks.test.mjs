import test from 'node:test';import assert from 'node:assert/strict';
import {postgresAdvisoryLocks} from '../src/pg-advisory-locks.mjs';
function fixture({failUnlock=false}={}){let connections=0;const events=[];const pool={async connect(){const id=++connections;return {async query(sql,args){events.push({id,op:sql.includes('unlock')?'unlock':'lock',key:args[0]});if(failUnlock&&sql.includes('unlock'))throw Error('Connection lost');},release(discard){events.push({id,op:'release',discard});}};}};return {pool,events,get connections(){return connections;}};}
test('nested advisory locks reuse one dedicated session and balance every acquisition',async()=>{
 const f=fixture(),lock=postgresAdvisoryLocks(f.pool);
 await lock(['b','a','a'],()=>lock(['c','b'],async()=>{assert.equal(f.connections,1);}));
 assert.equal(f.connections,1);assert.deepEqual(f.events.filter(e=>e.op==='lock').map(e=>e.key),['nextech:a','nextech:b','nextech:b','nextech:c']);
 assert.equal(f.events.filter(e=>e.op==='unlock').length,4);assert.equal(f.events.filter(e=>e.op==='release').length,1);
});
test('independent concurrent scopes have distinct sessions; callback failures still unlock',async()=>{
 const f=fixture(),lock=postgresAdvisoryLocks(f.pool);const results=await Promise.allSettled([lock(['x'],async()=>{throw Error('fixture failure');}),lock(['y'],async()=>{})]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(f.connections,2);assert.equal(f.events.filter(e=>e.op==='unlock').length,2);assert.equal(f.events.filter(e=>e.op==='release').length,2);
});
test('failed unlock discards the session instead of returning a potentially locked connection',async()=>{
 const f=fixture({failUnlock:true});await postgresAdvisoryLocks(f.pool)(['x'],async()=>{});assert.equal(f.events.find(e=>e.op==='release').discard,true);
});
