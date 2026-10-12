import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash}from'node:crypto';
import {validatePublicationReadiness}from'./publication-readiness.mjs';
import {spawnSync} from 'node:child_process';
test('queue CLI rejects an unready change without creating a request',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v3-queue-test-'));
 try{
  const queueDir=path.join(dir,'coordination-deploiement');await fs.mkdir(queueDir);
  for(const file of ['queue.mjs','publication-readiness.mjs','queue-paths.mjs','queue-bridge.mjs','queue-replacements.mjs'])await fs.copyFile(new URL(file,import.meta.url),path.join(queueDir,file));
  await fs.writeFile(path.join(dir,'candidate.js'),'test');
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({section:2,summary:'isolated test',ready:false,files:[{serverPath:'src/test.js',baselineSha256:'NEW',preparedPath:'candidate.js'}],tests:{},restartRequired:false}));
  const result=spawnSync(process.execPath,[path.join(queueDir,'queue.mjs'),'enqueue','manifest.json'],{cwd:dir,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/non prêt/);assert.deepEqual(await fs.readdir(path.join(queueDir,'requests')),[]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a pending manifest cannot enter the ready queue',async()=>{await assert.rejects(validatePublicationReadiness('.',{ready:false}),/non prêt/);});
test('open gates and missing Git evidence are rejected',async()=>{
 await assert.rejects(validatePublicationReadiness('.',{ready:true,openGates:['test']}),/blocages/);
 await assert.rejects(validatePublicationReadiness('.',{ready:true,openGates:[]}),/Git/);
});
test('proofs are bound to the commit and file bytes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'v3-readiness-'));try{
 const bytes='isolated test evidence',sha=createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(dir,'proof.txt'),bytes);
 const check={status:'PASS',proofPath:'proof.txt',sha256:sha};const m={ready:true,openGates:[],git:{pushVerified:true,commit:'a'.repeat(40)},verification:{status:'PASS',commit:'a'.repeat(40),functional:check,serverBaseline:check,performance:check,visualDesktop:check,visualMobile:check},files:[{serverPath:'public/test.js',preparedPath:'proof.txt',preparedSha256:sha}]};
 await validatePublicationReadiness(dir,m);m.verification.commit='b'.repeat(40);await assert.rejects(validatePublicationReadiness(dir,m),/autre commit/);m.verification.commit=m.git.commit;await fs.writeFile(path.join(dir,'proof.txt'),'changed');await assert.rejects(validatePublicationReadiness(dir,m),/preuve modifiée/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

