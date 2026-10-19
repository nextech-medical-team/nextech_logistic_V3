// Isolated schema only, shared by three max:1 pools. No provider requests.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {Pool} from 'pg';
const url=process.env.TEST_QUOTA_DATABASE_URL;if(!url)throw Error('Isolated test database URL required');
const schema='erplain_priority_'+randomUUID().replaceAll('-',''),pool=new Pool({connectionString:url}),children=[],grants=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await pool.query('CREATE SCHEMA '+schema);await pool.query('CREATE TABLE '+schema+'.api_budget(key text PRIMARY KEY,next_at timestamptz NOT NULL)');
 const connection=new URL(url);connection.searchParams.set('options','-c search_path='+schema);
 for(let i=0;i<3;i++){
  const child=fork(new URL('./test-erplain-priority-postgres-child.mjs',import.meta.url),[],{env:{...process.env,TEST_QUOTA_DATABASE_URL:connection.href},stdio:['ignore','inherit','inherit','ipc']});children.push(child);
  await new Promise((resolve,reject)=>{child.once('message',m=>m.ready?resolve():reject(Error(JSON.stringify(m))));child.once('error',reject);});
 }
 await pool.query('INSERT INTO '+schema+".api_budget VALUES('erplain:shared',clock_timestamp()+interval '3 seconds')");
 const results=children.map(child=>new Promise((resolve,reject)=>{child.on('message',m=>{if(m.grant)grants.push(m);if(m.done)resolve(m);if(m.error)reject(Error(m.error));});child.once('error',reject);}));
 for(let i=0;i<3;i++){
  children[i].send({acquire:true,traffic:i===0?'background':'foreground',count:i===0?2:4});
  if(i<2){const until=Date.now()+5000;for(;;){const exists=(await pool.query('SELECT to_regclass($1) AS name',[schema+'.erplain_quota_waiters'])).rows[0].name;
   if(exists&&Number((await pool.query('SELECT count(*) n FROM '+schema+'.erplain_quota_waiters')).rows[0].n)>=i+1)break;
   if(Date.now()>until)throw Error('Admission ticket not registered');await sleep(20);}}
 }
 const done=await Promise.all(results);assert.equal(new Set(done.map(x=>x.backend)).size,3);
 assert.equal(grants.length,10);grants.sort((a,b)=>a.at-b.at);
 assert.deepEqual(grants.slice(0,5).map(x=>x.traffic),['foreground','foreground','foreground','foreground','background']);
 for(let i=1;i<grants.length;i++)assert.ok(grants[i].at-grants[i-1].at>=60,'shared spacing must hold across pools');
 assert.equal(Number((await pool.query('SELECT count(*) n FROM '+schema+'.erplain_quota_waiters')).rows[0].n),0);
 const metrics=(await pool.query('SELECT * FROM '+schema+'.erplain_quota_turns')).rows[0];assert.equal(Number(metrics.foreground_grants),8);assert.equal(Number(metrics.background_grants),2);
 console.log(JSON.stringify({status:'PASS',realPostgreSQL:true,independentProcesses:3,maxConnectionsPerPool:1,foreground:8,background:2,providerCalls:0,productionTouched:false}));
}finally{
 await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.send({close:true});})));
 await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();
}
