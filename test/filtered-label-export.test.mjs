import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {labelDownloadRoutes} from '../src/label-downloads.mjs';
const source=fs.readFileSync(new URL('../public/improvements.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function collectFilteredLabelOrders('),source.indexOf('const filteredBatchLabels='));
const collect=vm.runInNewContext(helper+';collectFilteredLabelOrders',{URLSearchParams});
for(const count of [0,1,50,51,400,501,1201])test('all filtered orders: '+count,async()=>{
 const calls=[];const ids=await collect('channel=amazon&channel=temu&status=ready&problem-label=poids&from=2026-10-01&sort=reference&direction=asc&page=4',async url=>{
  const q=new URL(url,'http://fixture').searchParams;calls.push(q);const page=Number(q.get('page'));
  assert.equal(q.get('pageSize'),'200');assert.deepEqual(q.getAll('channel'),['amazon','temu']);assert.equal(q.get('problem-label'),'poids');assert.equal(q.get('from'),'2026-10-01');assert.equal(q.get('sort'),'reference');
  return {total:count,pages:Math.max(1,Math.ceil(count/200)),rows:Array.from({length:Math.max(0,Math.min(200,count-(page-1)*200))},(_,i)=>({id:'order-'+((page-1)*200+i)}))};
 });assert.equal(ids.length,count);assert.equal(new Set(ids).size,count);assert.equal(calls.length,Math.max(1,Math.ceil(count/200)));
});
test('changed population is never silently truncated',async()=>{let n=0;await assert.rejects(collect('',async()=>({total:++n===1?201:202,pages:2,rows:Array.from({length:200},(_,i)=>({id:String(i)}))})),/changé/);});
test('missing page is rejected',async()=>{await assert.rejects(collect('',async()=>({total:51,pages:1,rows:[{id:'one'}]})),/incomplète/);});
test('duplicates are rejected',async()=>{await assert.rejects(collect('',async()=>({total:2,pages:1,rows:[{id:'one'},{id:'one'}]})),/changé/);});
for(const count of [501,1201])test('server accepts '+count+' selections',async()=>{
 const queries=[];let reply;const ids=Array.from({length:count},(_,i)=>'order-'+i);
 const db={query:async(sql,args)=>{queries.push({sql,args});return {rows:sql.startsWith('INSERT')?[{id:args[0]}]:[]};}};
 await labelDownloadRoutes({p:'/api/labels/batches',req:{method:'POST'},db,user:{email:'test@example.invalid'},body:async()=>({ids}),json:(res,status,value)=>{reply={status,value};}});
 assert.equal(reply.status,202);assert.equal(JSON.parse(queries.find(q=>q.sql.startsWith('INSERT')).args[2]).ids.length,count);
});
test('empty selection remains invalid',async()=>{await assert.rejects(labelDownloadRoutes({p:'/api/labels/batches',req:{method:'POST'},body:async()=>({ids:[]})}),/au moins/);});

test('merged PDF includes all 501 orders and their additional parcels without source changes',async()=>{
 const {buildLabelDownload}=await import('../src/label-downloads.mjs');const {PDFDocument}=await import('pdf-lib');const {digest}=await import('../src/label-sku-copy.mjs');
 const original=await PDFDocument.create();original.addPage([200,300]);const bytes=Buffer.from(await original.save()),before=digest(bytes);const count=501;
 const db={query:async(sql,args)=>{
  assert.ok(sql.startsWith('SELECT'),'read-only document collection');
  if(sql.startsWith('SELECT orders.*'))return {rows:[{id:args[0],reference:args[0],channel:'amazon',carrier:'gls',skus:['SKU'],erp_live:{}}]};
  if(sql.startsWith('SELECT d.pdf,d.document_index FROM carrier_documents'))return {rows:[{pdf:bytes,document_index:0}]};
  if(sql.startsWith('SELECT id,pdf FROM extra_parcels'))return {rows:args[0]==='order-0'?[{id:'extra',pdf:bytes}]:[]};
  if(sql.startsWith('SELECT source_hash,pdf,order_id,created_at FROM label_sku_copies'))return {rows:[{source_hash:before,pdf:bytes,order_id:args[0],created_at:'2026-10-01'}]};
  if(sql.startsWith('SELECT id,carrier,partial_mode FROM orders'))return {rows:[{id:args[0],carrier:'gls',partial_mode:false}]};
  if(sql.startsWith('SELECT detail FROM audit'))return {rows:[]};
  throw Error('Unexpected query '+sql);
 }};
 const job={};const began=performance.now();await buildLabelDownload(db,{ids:Array.from({length:count},(_,i)=>'order-'+i)},job);
 assert.equal(job.status,'complete');assert.equal(job.items.length,count);assert.equal(job.labels,502);assert.equal((await PDFDocument.load(job.pdf)).getPageCount(),502);assert.equal(digest(bytes),before);assert.ok(job.items.every(x=>!x.problems.length));
 console.log(JSON.stringify({scope:'synthetic 501 orders / 502 existing PDF labels',elapsedMs:performance.now()-began,pages:job.pages,bytes:job.pdf.length}));
});
