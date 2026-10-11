import {Pool} from 'pg';import {configureApiBudget,apiAcquireSlot} from '../src/api-budget.mjs';
const pool=new Pool({connectionString:process.env.TEST_QUOTA_DATABASE_URL,max:1});
const db={kind:'postgres',query:(s,a)=>pool.query(s,a),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn({query:(s,a)=>c.query(s,a)});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
configureApiBudget(db);process.send({ready:true});
process.on('message',async message=>{if(message.close){await pool.end();process.disconnect();return;}if(message.acquire){try{await apiAcquireSlot('shared',30,{fair:true,maxWaitMs:10000});process.send({done:true,backend:(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid});}catch(e){process.send({error:e.message});}}});
