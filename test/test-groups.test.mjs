import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runTestGroups} from '../scripts/test-groups.mjs';

// These fixtures deliberately launch a separate test runner. Node otherwise
// suppresses nested --test children inherited from this file's test context.
function runFixtures(groups,options){
 const context=process.env.NODE_TEST_CONTEXT;
 delete process.env.NODE_TEST_CONTEXT;
 try{return runTestGroups(groups,options);}
 finally{if(context!==undefined)process.env.NODE_TEST_CONTEXT=context;}
}

test('test launcher runs all groups, reports progress and stops after a failed assertion',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'v3-test-groups-'));
 try{
  const pass=path.join(dir,'pass.test.mjs'),fail=path.join(dir,'fail.test.mjs');
  writeFileSync(pass,"import test from 'node:test';test('passes',()=>{});");
  writeFileSync(fail,"import test from 'node:test';test('fails',()=>{throw Error('expected fixture failure')});");
  const logs=[];
  assert.equal(runFixtures([['--test',pass],['--test',pass]],{log:s=>logs.push(s)}),0);
  assert.equal(logs.filter(s=>s.includes(' PASS ')).length,2);
  assert.match(logs[0],/concurrency=2 timeout=300000ms/);
  logs.length=0;
  assert.notEqual(runFixtures([['--test',fail],['--test',pass]],{log:s=>logs.push(s)}),0);
  assert.equal(logs.length,2);
  assert.match(logs[1],/FAIL/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a hanging test fails within its file deadline and identifies the blocked group',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'v3-test-timeout-'));
 try{
  const file=path.join(dir,'hang.test.mjs');
  writeFileSync(file,"import test from 'node:test';test('hangs',async()=>{await new Promise(()=>{setInterval(()=>{},1000)})});");
  const logs=[],started=Date.now();
  assert.notEqual(runFixtures([['--test',file]],{timeoutMs:500,log:s=>logs.push(s)}),0);
  assert.ok(Date.now()-started<10_000);
  assert.match(logs.at(-1),/FAIL/);
  assert.ok(logs.at(-1).includes(file));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('three test files never exceed the two-process build limit',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'v3-test-concurrency-'));
 try{
  const events=path.join(dir,'events.log');
  const files=Array.from({length:3},(_,i)=>{
   const file=path.join(dir,`${i}.test.mjs`);
   writeFileSync(file,`import test from 'node:test';import {appendFileSync} from 'node:fs';test('fixture',async()=>{appendFileSync(${JSON.stringify(events)},'start\\n');await new Promise(r=>setTimeout(r,300));appendFileSync(${JSON.stringify(events)},'end\\n')});`);
   return file;
  });
  assert.equal(runFixtures([['--test',...files]],{log:()=>{}}),0);
  let active=0,max=0;
  for(const event of readFileSync(events,'utf8').trim().split('\n')){active+=event==='start'?1:-1;max=Math.max(max,active);}
  assert.equal(max,2);
  assert.equal(active,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
