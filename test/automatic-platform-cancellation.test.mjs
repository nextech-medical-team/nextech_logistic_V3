import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeAutomaticPlatformCancellation,automaticPlatformCancellation,cancellationSchedule,automaticCancellationControl} from '../src/automatic-platform-cancellation.mjs';
import {initializePlatformCancellationReports,platformCancellationReports} from '../src/platform-cancellation-reports.mjs';
const initializeControls=db=>db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value JSONB);CREATE TABLE audit(user_email TEXT,action TEXT,detail JSONB)');

test('daily schedule uses Paris and starts at 07:30 in winter and summer',()=>{
 assert.equal(cancellationSchedule(new Date('2026-11-07T06:29:59Z')).due,false);
 assert.deepEqual(cancellationSchedule(new Date('2026-11-07T06:30:00Z')),{day:'2026-11-07',due:true});
 assert.equal(cancellationSchedule(new Date('2026-07-07T05:29:59Z')).due,false);
 assert.deepEqual(cancellationSchedule(new Date('2026-07-07T05:30:00Z')),{day:'2026-07-07',due:true});
});

test('scan completes before applying; restart resumes and finished day does not repeat',async()=>{
 const db=new PGlite();
 try{
  await initializeControls(db);await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
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
  await initializeControls(db);await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
  let fail=true;
  const reports=platformCancellationReports(db,{async next(){if(fail){fail=false;throw Error('offline');}return {done:true};},async apply(){assert.fail('empty report');}});
  const worker=automaticPlatformCancellation(db,reports,{now:()=>new Date('2026-11-07T10:00:00Z')});
  await assert.rejects(()=>worker.run(),/offline/);await worker.run();await worker.run();
  assert.equal((await db.query('SELECT phase FROM automatic_platform_cancellation')).rows[0].phase,'complete');
 }finally{await db.close();}
});

test('persisted switch prevents new scans and pauses existing scans and applications across restarts',async()=>{
 const db=new PGlite(),admin={role:'admin',email:'admin@example.test'};
 try{
  await initializeControls(db);await initializePlatformCancellationReports(db);await initializeAutomaticPlatformCancellation(db);
  let scans=0,applications=0;
  const reports=platformCancellationReports(db,{next:async input=>{scans++;return input.cursor?{done:true}:{done:false,cursor:'a',result:{id:'a',platformCancelled:true}};},apply:async()=>{applications++;return {result:{id:'a',applied:true}};}});
  const make=()=>automaticPlatformCancellation(db,reports,{now:()=>new Date('2026-11-10T10:00:00Z')});let worker=make();
  await automaticCancellationControl(db,{enabled:false},admin);await worker.run();
  assert.equal(scans,0);assert.equal((await db.query('SELECT * FROM automatic_platform_cancellation')).rows.length,0);
  await automaticCancellationControl(db,{enabled:true},admin);await worker.run();assert.equal(scans,1);
  await automaticCancellationControl(db,{enabled:false},admin);worker=make();await worker.run();assert.equal(scans,1);
  assert.deepEqual(await automaticCancellationControl(db,undefined,{role:'operator'}),{enabled:false,canManage:false});
  await automaticCancellationControl(db,{enabled:true},admin);await worker.run();assert.equal(scans,2);
  await automaticCancellationControl(db,{enabled:false},admin);await worker.run();assert.equal(applications,0);
  await automaticCancellationControl(db,{enabled:true},admin);await worker.run();assert.equal(applications,1);
  assert.equal((await db.query('SELECT * FROM automatic_platform_cancellation')).rows.length,1);
  assert.equal((await db.query("SELECT * FROM audit WHERE action='order.automatic_platform_cancellation_control'")).rows.length,6);
 }finally{await db.close();}
});

test('switch is rechecked after awaited report reads before launching the next scan',async()=>{
 let enabled=true,scans=0;
 const db={query:async sql=>({rows:sql.includes('FROM settings')?[{value:{'platform-cancellation':enabled}}]:[{day:'2026-11-10',phase:'checking',report_id:'r',cursor:'a'}]})};
 const worker=automaticPlatformCancellation(db,{read:async()=>{enabled=false;return {scan_complete:false};},next:async()=>{scans++;throw Error('Must not launch');}});
 await worker.run();assert.equal(scans,0);
});

test('automatic switch rejects unauthorized writes and invalid values before database access',async()=>{
 const db={query:async()=>assert.fail('No database access')};
 for(const role of ['operator','manager','viewer'])await assert.rejects(()=>automaticCancellationControl(db,{enabled:false},{role}),/administrateurs|Droits/);
 for(const input of [null,{},[],{enabled:'false'},{enabled:false,other:true}])await assert.rejects(()=>automaticCancellationControl(db,input,{role:'admin'}),/invalide/);
 await assert.rejects(()=>automaticCancellationControl(db,undefined,{role:'viewer'}),/Droits/);
});
