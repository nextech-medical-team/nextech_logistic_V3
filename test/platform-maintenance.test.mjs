import test from 'node:test';import assert from 'node:assert/strict';
import {runPlatformHoldMaintenance,rollbackPlatformHoldMaintenance,savePlatformMaintenanceReport,isPlatformMaintenanceEntry,assertPlatformMaintenanceDatabase} from '../src/platform-hold-maintenance.mjs';import pg from 'pg';
import {authorizedTemuScope,authorizedFreshTemu} from '../src/temu-authorized-reimport.mjs';
import {mkdtemp,writeFile,readFile,readdir,stat,lstat,symlink,unlink,rmdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
test('Private TEMU authorization is kept outside Git and independent of declared status',async()=>{
 assert.throws(()=>authorizedTemuScope([['PO-1-2','123'],['PO-1-2','123']]));assert.throws(()=>authorizedTemuScope([['BAD','123']]));assert.throws(()=>authorizedTemuScope([['PO-1-2','invalid']]));
 const directory=await mkdtemp(path.join(os.tmpdir(),'nextech-scope-test-')),file=path.join(directory,'temu-authorized-reimport-scope.json'),old=process.env.DATA_DIR;
 try{await writeFile(file,JSON.stringify([['PO-1-2','123']]));process.env.DATA_DIR=directory;
  for(const status of [1,2,3,4,5,undefined])assert.equal(authorizedFreshTemu({channel:'temu',shop:'123',payload:{detail:{parentOrderMap:{parentOrderSn:'PO-1-2',parentOrderStatus:status}}}},{batch:'fresh-temu-34-20261008'}),true);
  assert.throws(()=>authorizedFreshTemu({channel:'temu',shop:'other',payload:{detail:{parentOrderMap:{parentOrderSn:'PO-1-2'}}}},{batch:'fresh-temu-34-20261008'}));
 }finally{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;await unlink(file);await rmdir(directory);}
});
test('Maintenance replaces historical platform cancellation reason, preserves cancelled Erplain documents and never creates jobs',async()=>{
 const at=new Date().toISOString(),payload={id:'1',name:'#TEST',created_at:at,updated_at:at,fulfillment_status:'fulfilled',financial_status:'refunded',cancelled_at:at,line_items:[{id:'2',sku:'SKU',quantity:1}],shipping_address:{name:'TEST',address1:'Street',zip:'10000',city:'City',country_code:'FR'}};
 const order={id:'order1',channel:'shopify',reference:'#TEST',source_payload:{...payload},issue:'Commande entièrement remboursée dans Shopify · BC et BL Erplain annulés',label_status:'cancelled',tracking_status:'cancelled',resolution_pending_resume:false,archived:false,erp_live:{bc:{status:'cancelled'},bl:{id:'4',status:'cancelled'}}};
 const original=structuredClone(order),tables={orders:[order],lines:[],jobs:[],erp_live_jobs:[],carrier_jobs:[],carrier_documents:[],document_lifecycle:[],extra_parcels:[],partial_deliveries:[],resolution_jobs:[],correction_jobs:[]};let updates=0;
 const db={query:async(sql,args)=>{
  if(sql.startsWith('LOCK TABLE'))return {rows:[]};
  if(sql.startsWith('UPDATE orders SET')){updates++;Object.assign(order,{source_payload:JSON.parse(args[1]),issue:args[2],resolution_pending_resume:args[3],label_status:args[4]});return {rows:[{id:order.id}]};}
  const table=sql.match(/SELECT \* FROM ([a-z_]+)/)?.[1];assert.ok(table,sql);return {rows:structuredClone(tables[table])};
 },transaction:async fn=>fn(db)};
 const report=await runPlatformHoldMaintenance({db,apply:true,pauseProbe:async()=>({paused:true,epoch:'test-pause'}),collect:async()=>({payload,checkedAt:new Date().toISOString(),origin:'provider',channel:'shopify',orderId:order.id,readOnly:true,complete:true})});
 assert.equal(report.status,'PASS');assert.equal(updates,1);assert.match(order.issue,/BC annulé dans Erplain/);assert.doesNotMatch(order.issue,/Shopify/);assert.deepEqual(order.erp_live,original.erp_live);assert.equal(order.tracking_status,original.tracking_status);assert.equal(order.label_status,'cancelled');assert.equal(order.resolution_pending_resume,false);assert.equal(report.newJobs,0);assert.equal(report.externalWrites,0);
 const restored=await rollbackPlatformHoldMaintenance({db,pauseProbe:async()=>({paused:true,epoch:'test-pause'}),report});assert.equal(restored.restored,1);assert.deepEqual(order,original);
});

function faultFixture(fault){
 const at=new Date().toISOString(),payload={id:'1',name:'#TEST',created_at:at,updated_at:at,fulfillment_status:'fulfilled',financial_status:'refunded',cancelled_at:at,line_items:[{id:'2',sku:'SKU',quantity:1}],shipping_address:{name:'TEST',address1:'Street',zip:'10000',city:'City',country_code:'FR'}};
 const order={id:'order1',channel:'shopify',reference:'#TEST',source_payload:{...payload},issue:'Commande entièrement remboursée dans Shopify · BC et BL Erplain annulés',label_status:'cancelled',tracking_status:'cancelled',resolution_pending_resume:false,archived:false,erp_live:{bc:{status:'cancelled'},bl:{id:'4',status:'cancelled'}}};
 const original=structuredClone(order),tables=Object.fromEntries(['orders','lines','jobs','erp_live_jobs','carrier_jobs','carrier_documents','document_lifecycle','extra_parcels','partial_deliveries','partial_documents','resolution_jobs','correction_jobs','temu_label_jobs'].map(n=>[n,n==='orders'?[order]:[]]));let written=false;
 const db={query:async(sql,args)=>{
  if(sql.startsWith('LOCK TABLE'))return {rows:[]};
  if(sql.startsWith('UPDATE orders SET')){Object.assign(order,{source_payload:JSON.parse(args[1]),issue:args[2],resolution_pending_resume:args[3],label_status:args[4]});written=true;if(fault==='preservation'){order.tracking_status='tampered';fault=undefined;}return {rows:[{id:order.id}]};}
  if(written&&fault==='evidence-read'&&sql.startsWith('SELECT * FROM orders')){fault=undefined;throw Error('Injected evidence read failure after write');}
  const table=sql.match(/SELECT \* FROM ([a-z_]+)/)?.[1];assert.ok(table,sql);return {rows:structuredClone(tables[table])};
 },transaction:async fn=>{
  const before=structuredClone(order);let committed=false;
  try{const result=await fn(db);if(fault==='before-commit'){fault=undefined;throw Error('Injected failure before COMMIT');}committed=true;if(fault==='commit-ack'){fault=undefined;throw Error('Injected lost COMMIT acknowledgment');}return result;}
  catch(e){if(!committed){for(const k of Object.keys(order))delete order[k];Object.assign(order,before);written=false;}throw e;}
 }};
 const pauseProbe=async()=>({paused:true,epoch:'test-pause'}),collect=async()=>({payload,checkedAt:new Date().toISOString(),origin:'provider',channel:'shopify',orderId:order.id,readOnly:true,complete:true});
 return {db,order,original,pauseProbe,collect};
}

for(const fault of ['evidence-read','preservation'])test('Maintenance '+fault+' failure after writing rolls back before commit with zero residual changes',async()=>{
 const f=faultFixture(fault),report=await runPlatformHoldMaintenance({...f,apply:true});assert.equal(report.status,'BLOCKED');assert.deepEqual(f.order,f.original);assert.equal(report.rows[0].commitState,undefined);
 const rollback=await rollbackPlatformHoldMaintenance({...f,report});assert.equal(rollback.restored,0);assert.deepEqual(f.order,f.original);
});

test('A lost commit acknowledgment remains journaled and rollback restores a BLOCKED committed row',async()=>{
 const f=faultFixture('commit-ack'),report=await runPlatformHoldMaintenance({...f,apply:true});assert.equal(report.status,'BLOCKED');assert.equal(report.rows[0].commitState,'prepared');assert.notDeepEqual(f.order,f.original);
 const rollback=await rollbackPlatformHoldMaintenance({...f,report});assert.equal(rollback.restored,1);assert.deepEqual(f.order,f.original);
});

test('A failure saving the final report recovers from the durable precommit journal',async()=>{
 const f=faultFixture();let durable;
 await assert.rejects(runPlatformHoldMaintenance({...f,apply:true,save:async report=>{if(report.rows[0]?.commitState==='committed')throw Error('Injected report write failure after COMMIT');durable=structuredClone(report);}}),/after COMMIT/);
 assert.equal(durable.rows[0].commitState,'prepared');assert.equal(durable.rows[0].status,'COMMIT_PENDING');assert.notDeepEqual(f.order,f.original);
 const rollback=await rollbackPlatformHoldMaintenance({...f,report:durable});assert.equal(rollback.restored,1);assert.deepEqual(f.order,f.original);
});

test('A prepared journal whose transaction did not commit is recognized without rewriting original data',async()=>{
 const f=faultFixture('before-commit'),report=await runPlatformHoldMaintenance({...f,apply:true});assert.equal(report.status,'BLOCKED');assert.equal(report.rows[0].commitState,'prepared');assert.deepEqual(f.order,f.original);
 const rollback=await rollbackPlatformHoldMaintenance({...f,report});assert.equal(rollback.restored,0);assert.equal(rollback.uncommitted,1);assert.deepEqual(f.order,f.original);
});

test('Atomic report replacement preserves the existing private journal when serialization fails',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'nextech-journal-test-')),file=path.join(directory,'journal.json');
 try{
  await savePlatformMaintenanceReport(file,{rows:[{commitState:'prepared'}]});const before=await readFile(file,'utf8');
  await assert.rejects(savePlatformMaintenanceReport(file,{invalid:1n}));assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(await readdir(directory),['journal.json']);
  if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
 }finally{await unlink(file);await rmdir(directory);}
});

test('The real maintenance CLI executes through a current directory symlink, while imports stay inactive',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'nextech-entry-test-')),current=path.join(directory,'current'),source=fileURLToPath(new URL('../src',import.meta.url));
 try{
  await symlink(source,current,'junction');const entry=path.join(current,'platform-hold-maintenance.mjs'),url=new URL('../src/platform-hold-maintenance.mjs',import.meta.url).href;
  assert.equal(await isPlatformMaintenanceEntry(url,entry),true);assert.equal(await isPlatformMaintenanceEntry(import.meta.url,entry),false);assert.equal(await isPlatformMaintenanceEntry('data:text/javascript,',entry),false);
  // Missing Section7 arguments must reach the actual CLI guard and fail before
  // credentials, production database, publication lock or services are accessed.
  await assert.rejects(promisify(execFile)(process.execPath,[entry]),e=>e.code===1&&e.stderr.includes('Maintenance réservée à Section7'));
 }finally{assert.ok((await lstat(current)).isSymbolicLink());await unlink(current);await rmdir(directory);}
});

test('Database guard accepts the actual Unix socket DSN and rejects another driver-selected database without connecting',()=>{
 const database='nextech_v3_migration';
 for(const url of ['postgresql://nextech@/'+database+'?host=/var/run/postgresql','postgres://nextech@localhost/'+database])assert.equal(assertPlatformMaintenanceDatabase(url,database,pg.Client),database);
 assert.throws(()=>assertPlatformMaintenanceDatabase('postgresql://nextech@/other?host=/var/run/postgresql',database,pg.Client));
 assert.equal(assertPlatformMaintenanceDatabase('postgresql://nextech@localhost/'+database+'?database=other',database,pg.Client),database);
 assert.throws(()=>assertPlatformMaintenanceDatabase('https://example.invalid/'+database,database,pg.Client));
});

test('Linux publication lock accepts the inherited locked descriptor and refuses a different open description or inode',{skip:process.platform!=='linux'},async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'nextech-lock-test-')),lock=path.join(directory,'publication.lock'),other=path.join(directory,'other.lock');
 const moduleUrl=new URL('../src/platform-hold-maintenance.mjs',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import {assertPlatformMaintenanceLock as check} from ${JSON.stringify(moduleUrl)};await check(9,${JSON.stringify(lock)});await assert.rejects(check(10,${JSON.stringify(lock)}),/Verrou exclusif indisponible/);await assert.rejects(check(11,${JSON.stringify(lock)}),/Descripteur du verrou différent/);console.log('LOCK_PASS');`;
 try{
  const result=await promisify(execFile)('/bin/bash',['-c','exec 9>"$1"; flock -x 9; exec 10>"$1"; exec 11>"$2"; "$3" --input-type=module -e "$4"','lock-test',lock,other,process.execPath,script]);assert.ok(result.stdout.includes('LOCK_PASS'));
 }finally{for(const file of [lock,other])await unlink(file);await rmdir(directory);}
});
