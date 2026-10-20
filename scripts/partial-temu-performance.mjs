import {PGlite} from '@electric-sql/pglite';
import {partialService,initializePartialDeliveries} from '../src/partial-deliveries.mjs';
const e=new PGlite();let selects=0,providerCalls=0;
const db={query:(...a)=>{selects++;return e.query(...a);},exec:(...a)=>e.exec(...a)};
try{
 await e.exec('CREATE TABLE orders(id text primary key,suspension jsonb);');await initializePartialDeliveries(db);
 await e.exec("INSERT INTO orders VALUES('o','{}');INSERT INTO partial_deliveries(id,order_id,request_id,status,selection,label_choice,temu_label) SELECT 'd'||n,'o','r'||n,'temu_wait','[]','bl_only_temu','{\"nextAt\":\"2099-01-01T00:00:00Z\"}' FROM generate_series(1,10000) n");
 selects=0;const worker=partialService(db,'unused',{api:{},temu:{advance:async()=>providerCalls++}}),start=performance.now();for(let i=0;i<25;i++)await worker.run();
 console.log(JSON.stringify({status:selects===25&&providerCalls===0?'PASS':'FAIL',deliveries:10000,ticks:25,selects,providerCalls,elapsedMs:performance.now()-start}));
}finally{await e.close();}
