// Isolated CI database only. No production URL or provider endpoint.
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fork} from 'node:child_process';import {Pool} from 'pg';
const url=process.env.TEST_QUOTA_DATABASE_URL;if(!url)throw Error('Isolated test database URL required');
const schema='quota_test_'+randomUUID().replaceAll('-',''),pool=new Pool({connectionString:url}),children=[],order=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await pool.query('CREATE SCHEMA '+schema);await pool.query('CREATE TABLE '+schema+'.api_budget(key text PRIMARY KEY,next_at timestamptz NOT NULL)');await pool.query('CREATE TABLE '+schema+'.api_budget_waiters(id text PRIMARY KEY,key text NOT NULL,ticket bigserial UNIQUE,expires_at timestamptz NOT NULL)');
 const connection=new URL(url);connection.searchParams.set('options','-c search_path='+schema);
 for(let i=0;i<3;i++){
  const child=fork(new URL('./test-quota-postgres-child.mjs',import.meta.url),[],{env:{...process.env,TEST_QUOTA_DATABASE_URL:connection.href},stdio:['ignore','inherit','inherit','ipc']});children.push(child);
  await new Promise((resolve,reject)=>{child.once('message',message=>{if(message.ready)resolve();else reject(Error(JSON.stringify(message)));});child.once('error',reject);child.once('exit',code=>reject(Error('Child exit '+code)));});
 }
 assert.equal(new Set(children.map(c=>c.pid)).size,3);
 await pool.query('INSERT INTO '+schema+".api_budget VALUES('shared',clock_timestamp()+interval '3 seconds')");
 const results=children.map((child,i)=>new Promise((resolve,reject)=>{child.on('message',m=>{if(m.done){order.push(i);resolve(m);}if(m.error)reject(Error(m.error));});child.once('exit',code=>{if(code)reject(Error('Child exit '+code));});}));
 for(let i=0;i<3;i++){
  children[i].send({acquire:true});
  if(i<2){const until=Date.now()+5000;for(;;){const n=Number((await pool.query('SELECT count(*) n FROM '+schema+'.api_budget_waiters')).rows[0].n);if(n>=i+1)break;if(Date.now()>until)throw Error('Ticket not registered');await sleep(20);}}
 }
 const done=await Promise.all(results);assert.deepEqual(order,[0,1,2]);assert.equal(Number((await pool.query('SELECT count(*) n FROM '+schema+'.api_budget_waiters')).rows[0].n),0);
 assert.equal(new Set(done.map(d=>d.backend)).size,3);
 console.log(JSON.stringify({status:'PASS',realPostgreSQL:true,independentProcesses:3,independentSessions:3,fifo:order,providerCalls:0,productionTouched:false}));
}finally{
 await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.send({close:true});})));
 await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();
}
