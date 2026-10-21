import {Pool} from 'pg';
import {apiAcquireSlot,configureApiBudget} from '../src/api-budget.mjs';
import {withErplainTraffic} from '../src/erplain-admission.mjs';
const pool=new Pool({connectionString:process.env.TEST_QUOTA_DATABASE_URL,max:1});
let grantProof;
const db={kind:'postgres',query:(s,p)=>pool.query(s,p),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn({query:async(s,p)=>{
 // Add only RETURNING evidence in this isolated test adapter. The admission
 // predicate, clock, deadline, parameters and production source are unchanged.
 const admission=s.includes('INSERT INTO api_budget(')&&s.includes('RETURNING key');
 const result=await c.query(admission?s.replace('RETURNING key','RETURNING key, (extract(epoch FROM next_at)*1000000)::bigint::text AS next_allowed_us'):s,p);
 if(admission&&result.rows.length){const nextAllowedUs=result.rows[0].next_allowed_us;grantProof={nextAllowedUs,grantedAtUs:String(BigInt(nextAllowedUs)-BigInt(p[1])*1000n)};}
 return result;
 }});await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
configureApiBudget(db);process.send({ready:true});
process.on('message',async message=>{
 if(message.close){await pool.end();process.disconnect();return;}
 if(message.acquire)try{
  await withErplainTraffic(message.traffic,async()=>{for(let i=0;i<message.count;i++){
   grantProof=null;await apiAcquireSlot('erplain:shared',100,{fair:true,maxWaitMs:15000});
   if(!grantProof)throw Error('PostgreSQL grant proof missing');
   // Reproduce scheduler/cleanup/report delays without weakening the SQL proof.
   if(i===0&&message.reportDelayMs)await new Promise(resolve=>setTimeout(resolve,message.reportDelayMs));
   process.send({grant:true,traffic:message.traffic,at:Date.now(),...grantProof});
  }});
  process.send({done:true,backend:(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid});
 }catch(e){process.send({error:e.message});}
});
