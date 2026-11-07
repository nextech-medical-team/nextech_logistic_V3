import {manualPlatformCancellation} from '../src/manual-platform-cancellation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeAutomaticPlatformCancellation,automaticPlatformCancellation,cancellationSchedule} from '../src/automatic-platform-cancellation.mjs';
import {initializePlatformCancellationReports,platformCancellationReports} from '../src/platform-cancellation-reports.mjs';

test('daily schedule uses Paris and starts at 07:30 in winter and summer',()=>{
 assert.equal(cancellationSchedule(new Date('2026-11-07T06:29:59Z')).due,false);
 assert.deepEqual(cancellationSchedule(new Date('2026-11-07T06:30:00Z')),{day:'2026-11-07',due:true});
 assert.equal(cancellationSchedule(new Date('2026-07-07T05:29:59Z')).due,false);
 assert.deepEqual(cancellationSchedule(new Date('2026-07-07T05:30:00Z')),{day:'2026-07-07',due:true});
});

test('scan completes before applying; restart resumes and finished day does not repeat',async()=>{
 const db=new PGlite();
 try{
  await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
  let scans=0,applications=0,date=new Date('2026-11-07T06:29:00Z');
  const reports=platformCancellationReports(db,{
   async next(input){scans++;return input.cursor?{done:true}:{done:false,cursor:'a',result:{id:'a',platformCancelled:true}};},
   async apply(){applications++;return {result:{id:'a',applied:true}};}
  });
  const make=()=>automaticPlatformCancellation(db,reports,{now:()=>date});
  let worker=make();await worker.run();assert.equal(scans,0);
  date=new Date('2026-11-07T06:30:00Z');await worker.run();assert.equal(scans,1);assert.equal(applications,0);
  worker=make();await worker.run();assert.equal(scans,2);assert.equal(applications,0);
  await worker.run();assert.equal(applications,1);
  await worker.run();await worker.run();assert.equal(scans,2);assert.equal(applications,1);
  const history=await reports.history();assert.equal(history.rows[0].status,'complete');
  date=new Date('2026-11-08T06:30:00Z');await worker.run();assert.equal(scans,3);
 }finally{await db.close();}
});

test('empty scan completes without application and transient errors are retried',async()=>{
 const db=new PGlite();
 try{
  await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
  let fail=true;
  const reports=platformCancellationReports(db,{async next(){if(fail){fail=false;throw Error('offline');}return {done:true};},async apply(){assert.fail('empty report');}});
  const worker=automaticPlatformCancellation(db,reports,{now:()=>new Date('2026-11-07T10:00:00Z')});
  await assert.rejects(()=>worker.run(),/offline/);await worker.run();await worker.run();
  assert.equal((await db.query('SELECT phase FROM automatic_platform_cancellation')).rows[0].phase,'complete');
 }finally{await db.close();}
});


test('archived row is retained for review while the next row and day complete',async()=>{
 const db=new PGlite();
 try{
  await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
  let audit=0,applied=[];
  const missing=manualPlatformCancellation({async query(sql){
   if(sql.startsWith('SELECT * FROM orders'))return {rows:[]};
   assert.match(sql,/INSERT INTO audit/);audit++;return {rows:[]};
  }},'unused',{}, {shopify:{async cancel(){assert.fail('no provider call');}},connect:async()=>assert.fail('no provider call')});
  const reports=platformCancellationReports(db,{
   async next(){assert.fail('seeded scan is complete');},
   async apply(input,user){applied.push(input.id);return input.id==='a'?missing.apply(input,user):{result:{id:input.id,applied:true}};}
  });
  await db.query("INSERT INTO platform_cancellation_reports(id,owner,scope,scan_complete) VALUES('r','test','{}',true)");
  for(const id of ['a','b'])await db.query('INSERT INTO platform_cancellation_report_rows(report_id,order_id,checked) VALUES($1,$2,$3)',['r',id,JSON.stringify({id,platformCancelled:true})]);
  await db.query("INSERT INTO automatic_platform_cancellation(day,report_id,phase) VALUES('2026-11-07','r','applying')");
  const worker=automaticPlatformCancellation(db,reports,{now:()=>new Date('2026-11-07T09:00:00Z')});
  await worker.run();await worker.run();await worker.run();await worker.run();
  assert.deepEqual(applied,['a','b']);assert.equal(audit,1);
  const report=await reports.read('r');
  assert.equal(report.results[0].status,'review');assert.equal(report.results[0].applied,false);
  assert.equal(report.results[0].platformCancelled,true);assert.equal(report.results[1].applied,true);
  assert.equal((await db.query('SELECT phase FROM automatic_platform_cancellation')).rows[0].phase,'complete');
 }finally{await db.close();}
});
