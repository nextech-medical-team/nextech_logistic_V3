import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarginsService} from '../src/margins-service.mjs';

const db={query:async()=>({rows:[{id:'one',reference:'#1001',channel:'shopify'},{id:'two',reference:'TEMU-1',channel:'temu'}]})};
const missing=()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};

test('missing private snapshot allows startup and marks every margin incomplete',async()=>{
 const service=await createMarginsService(db,{readAsset:missing});
 for(const fresh of [false,true]){
  const result=await service.get({fresh});
  assert.equal(result.available,false);assert.equal(result.rows.length,2);
  assert.ok(result.rows.every(r=>r.status==='incomplete'&&r.profit===null&&r.issues.length===1));
 }
});

test('missing calculation sources also degrades without fabricating financial results',async()=>{
 const service=await createMarginsService(db,{readAsset:async url=>url.pathname.endsWith('snapshot.json')?'{}':missing()});
 assert.equal((await service.get()).available,false);
});

test('invalid JSON and unexpected filesystem errors are not silently ignored',async()=>{
 await assert.rejects(createMarginsService(db,{readAsset:async()=>'{broken'}),SyntaxError);
 await assert.rejects(createMarginsService(db,{readAsset:async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}}),{code:'EACCES'});
});

test('actual repository without private snapshot initializes the margins service',async()=>{
 const service=await createMarginsService(db);
 assert.equal(typeof service.get,'function');
});
