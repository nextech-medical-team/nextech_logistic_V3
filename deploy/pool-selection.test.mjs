import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./preserve-pool.mjs',import.meta.url),'utf8');
const body=source.match(/functionDeclaration:`([^`]+)`/)[1];
const preserve=Function('return ('+body+')')();
const pool=(max,ending=false)=>({options:{max},ending,totalCount:2,idleCount:1,waitingCount:0,_pulseQueue(){throw Error('Unexpected queue activity');}});
for(const reverse of [false,true])test('application pool selected with separate lock pool, reverse='+reverse,()=>{
 const app=pool(10),locks=pool(4);const result=preserve.call(reverse?[locks,app]:[app,locks]);
 assert.equal(app.options.max,20);assert.equal(locks.options.max,4);assert.equal(result.before.max,10);assert.equal(result.after.max,20);
});
test('legacy single pool and repeated preservation',()=>{const app=pool(10);preserve.call([app]);assert.equal(preserve.call([app]).before.max,20);});
for(const limits of [[],[4],[10,10],[10,20],[10,4,4],[10,3],[30]])test('ambiguous or unknown pools rejected '+limits,()=>{
 const pools=limits.map(x=>pool(x));assert.throws(()=>preserve.call(pools));assert.deepEqual(pools.map(p=>p.options.max),limits);
});
for(const ending of [10,4])test('ending pool rejected '+ending,()=>{const app=pool(10,ending===10),locks=pool(4,ending===4);assert.throws(()=>preserve.call([app,locks]));assert.equal(app.options.max,10);});
