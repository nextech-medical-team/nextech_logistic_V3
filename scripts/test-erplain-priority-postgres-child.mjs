import {Pool} from 'pg';
import {apiAcquireSlot,configureApiBudget} from '../src/api-budget.mjs';
import {withErplainTraffic} from '../src/erplain-admission.mjs';
const pool=new Pool({connectionString:process.env.TEST_QUOTA_DATABASE_URL,max:1});
const db={kind:'postgres',query:(s,p)=>pool.query(s,p),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn({query:(s,p)=>c.query(s,p)});await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
configureApiBudget(db);process.send({ready:true});
process.on('message',async message=>{
 if(message.close){await pool.end();process.disconnect();return;}
 if(message.acquire)try{
  await withErplainTraffic(message.traffic,async()=>{for(let i=0;i<message.count;i++){await apiAcquireSlot('erplain:shared',100,{fair:true,maxWaitMs:15000});process.send({grant:true,traffic:message.traffic,at:Date.now()});}});
  process.send({done:true,backend:(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid});
 }catch(e){process.send({error:e.message});}
});
