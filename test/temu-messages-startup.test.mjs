import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';

test('V3 starts without Temu credentials and orders stay accessible when messages are blocked', {timeout:90000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'nextech-temu-smoke-'));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
 const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const origin=`http://127.0.0.1:${port}`;
 const preload=path.join(directory,'no-provider-network.mjs');
 await writeFile(preload,"globalThis.fetch=async()=>{throw Error('Provider network disabled in isolated startup test');};");
 const env={...process.env,DATA_DIR:directory,CREDENTIALS_DIR:directory,DATABASE_URL:'',SHOP_VAULT_FILE:'',PORT:String(port),PUBLIC_ORIGIN:origin,APP_ROLE:'all',MIGRATION_PREPARATION:'1'};
 for(const key of Object.keys(env))if(/^(TEMU|ERPLAIN|SHOPIFY|GOFO|GLS)_/.test(key))delete env[key];
 let output='';const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,'src/server.mjs'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const closed=once(child,'close');child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 try{
  let ready=false;
  for(let i=0;i<300;i++){
   if(child.exitCode!==null)throw Error('Isolated V3 exited during startup: '+output.slice(-1500));
   try{if((await fetch(origin+'/api/status',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'isolated V3 must start within 30 seconds');
  const page=await fetch(origin+'/');assert.equal(page.status,200);
  assert.match(await page.text(),/temu-messages\.js/);
  assert.equal((await fetch(origin+'/temu-messages.js')).status,200);
  assert.match(await (await fetch(origin+'/style.css')).text(),/\.tm-statistics/);
  assert.equal((await fetch(origin+'/api/temu/messages')).status,401);
  const setup=await readFile(path.join(directory,'premiere-connexion.txt'),'utf8');
  const token=setup.match(/#setup=([a-f0-9]+)/)[1];
  const account={email:'isolated-temu@example.invalid',password:'Isolated-test-password-2026'};
  const post=(route,data,cookie)=>fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/api/setup',{...account,token})).status,201);
  const login=await post('/api/login',account);assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const read=route=>fetch(origin+route,{headers:{Cookie:cookie}});
  const before=await read('/api/orders');assert.equal(before.status,200);
  const messages=await read('/api/temu/messages');assert.equal(messages.status,200);
  const list=await messages.json();assert.equal(list.access.available,false);assert.equal(list.total,0);assert.equal(list.statistics.available,false);
  assert.equal((await post('/api/temu/messages/refresh',{},cookie)).status,409);
  const after=await read('/api/orders');assert.equal(after.status,200);
  assert.equal((await read('/api/dashboard')).status,200);
  assert.equal((await read('/api/me')).status,200);
 }finally{
  if(child.exitCode===null)child.kill();await closed;
  // Only remove the unique test directory returned by mkdtemp above.
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
