import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformCancellationReports,platformCancellationReports} from '../src/platform-cancellation-reports.mjs';

test('reports survive reopening and retain checks alongside application results',async()=>{
 const db=new PGlite();
 try{
  await initializePlatformCancellationReports(db);
  const user={email:'operator@example.test'},calls=[];
  const checked={id:'a',channel:'temu',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:false};
  const service={async next(input){calls.push(input);return input.cursor?{done:true}:{done:false,cursor:'a',result:checked};},async apply(input){calls.push(input);return {done:false,cursor:'a',result:{...checked,status:'review',error:'Stock à rapprocher'}};}};
  let reports=platformCancellationReports(db,service);
  const first=await reports.next({channels:['temu'],createdFrom:'2026-10-14T00:00:00Z'},user),reportId=first.reportId;
  assert.ok(reportId);
  assert.equal((await reports.history()).rows.length,1);
  await assert.rejects(()=>reports.apply({reportId,id:'a'},user),/incomplète/);
  await reports.finish({reportId,issues:['Connexion interrompue']});
  assert.equal((await reports.read(reportId)).status,'interrupted');
  await reports.next({reportId,cursor:'a',channels:['shopify']},user);
  assert.deepEqual(calls.at(-1).channels,['temu']);
  await assert.rejects(()=>reports.apply({reportId,id:'missing'},user),/absente/);
  await reports.apply({reportId,id:'a'},user);
  await reports.finish({reportId,issues:[]});
  reports=platformCancellationReports(db,service);
  const saved=await reports.read(reportId);
  assert.equal(saved.status,'complete');
  assert.equal(saved.scan_complete,true);
  assert.equal(saved.checks[0].status,'cancelled');
  assert.equal(saved.results[0].status,'review');
  assert.equal(saved.results[0].error,'Stock à rapprocher');
  assert.equal(saved.results[0].v3Cancelled,false);
  assert.deepEqual(saved.issues,[]);
  await assert.rejects(()=>reports.next({reportId,cursor:'a'},user),/terminée/);
 }finally{await db.close();}
});

test('successful application and empty scans are persisted',async()=>{
 const db=new PGlite();
 try{
  await initializePlatformCancellationReports(db);
  const checked={id:'a',channel:'shopify',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:false};
  const reports=platformCancellationReports(db,{next:async input=>input.cursor?{done:true}:{done:false,cursor:'a',result:checked},apply:async()=>({result:{...checked,applied:true,v3Cancelled:true}})});
  const user={email:'operator@example.test'},first=await reports.next({},user),reportId=first.reportId;
  await reports.next({reportId,cursor:'a'},user);
  await reports.apply({reportId,id:'a'},user);
  await reports.finish({reportId,issues:[]});
  assert.equal((await reports.read(reportId)).results[0].applied,true);
  assert.equal((await reports.read(reportId)).checks[0].v3Cancelled,false);
  const empty=platformCancellationReports(db,{next:async()=>({done:true})});
  const response=await empty.next({},user);
  assert.equal((await empty.read(response.reportId)).status,'ready');
  assert.deepEqual((await empty.read(response.reportId)).results,[]);
  await assert.rejects(()=>reports.read('missing'),/introuvable/);
 }finally{await db.close();}
});
