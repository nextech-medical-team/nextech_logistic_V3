import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createTemuExcelTestDatabase} from './support/temu-excel-db.mjs';
import {initializeTemuShipping,temuShipping} from '../src/temu-shipping.mjs';
const reference='PO-020-123456789',other='PO-020-987654321';
const original=Buffer.from('%PDF-original'),digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{packages=['PK-123'],source=null,archived=[],status=1,grouped=false,duplicate=false,warning=false}={}){
 const db=await createTemuExcelTestDatabase();t.after(()=>db.close());await initializeTemuShipping(db);
 await db.query('INSERT INTO temu_label_jobs(reference,status,packages,result,error) VALUES($1,\'document_unavailable\',$2,$3,\'old PDF error\')',[reference,JSON.stringify(packages),JSON.stringify(source?{source}:{})]);
 await db.query('INSERT INTO temu_label_jobs(reference,status,packages) VALUES($1,\'complete\',$2)',[other,JSON.stringify(packages)]);
 for(const [ref,p,pdf] of archived)await db.query('INSERT INTO temu_label_documents VALUES($1,$2,$3)',[ref,p,pdf]);
 const documentCalls=[],downloads=[],reads=[];
 const api={async read(type,input){reads.push(type);
  if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:packages.map(packageSn=>({packageSn,shippingLabelStatus:status,trackingNumber:'TRACK-'+packageSn,orderSendInfoList:[{parentOrderSn:reference},...(grouped?[{parentOrderSn:other}]:[])]}))};
  if(type==='bg.logistics.shipment.document.get'){
   documentCalls.push(input.packageSnList);
   if(warning)return {warningMessage:['picked up package cannot be printed (120018027)'],shippingLabelUrlList:[]};
   const urls=input.packageSnList.map(packageSn=>({packageSn,documentType:'SHIPPING_LABEL_PDF',url:'https://example.invalid/'+packageSn}));
   return {shippingLabelUrlList:duplicate?urls.concat(urls):urls};
  }
  throw Error('Unexpected API '+type);
 },async pdf(url){downloads.push(url);return original;},async buy(){throw Error('No purchase allowed');}};
 return {db,api,documentCalls,downloads,reads,service:temuShipping(db,api)};
}
for(const source of [null,'legacy_import','temu_direct'])test('archived PDF is reused without a second download, provenance '+source,async t=>{
 const f=await fixture(t,{source,archived:[[reference,'PK-123',original]],warning:true});
 for(let i=0;i<3;i++)assert.equal((await temuShipping(f.db,f.api).recover(reference)).status,'complete');
 assert.deepEqual(f.documentCalls,[]);assert.deepEqual(f.downloads,[]);
 const row=(await f.db.query('SELECT pdf FROM temu_label_documents WHERE reference=$1',[reference])).rows[0];assert.equal(digest(row.pdf),digest(original));
 assert.equal((await f.db.query('SELECT error FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0].error,null);
});
test('only a missing package is downloaded; an existing partial label remains identical',async t=>{
 const f=await fixture(t,{packages:['PK-123','PK-456'],archived:[[reference,'PK-123',original]]});
 await f.service.recover(reference);await temuShipping(f.db,f.api).recover(reference);
 assert.deepEqual(f.documentCalls,[['PK-456']]);assert.equal(f.downloads.length,1);
 assert.equal((await f.db.query('SELECT count(*) n FROM temu_label_documents WHERE reference=$1',[reference])).rows[0].n,2);
});
test('duplicate URLs and restart do not download the same PDF twice',async t=>{
 const f=await fixture(t,{duplicate:true});assert.equal((await f.service.recover(reference)).status,'complete');
 await temuShipping(f.db,f.api).recover(reference);assert.equal(f.downloads.length,1);assert.equal(f.documentCalls.length,1);
});
test('two service instances serialize a first download for the same package',async t=>{
 const f=await fixture(t);await Promise.all([f.service.recover(reference),temuShipping(f.db,f.api).recover(reference)]);
 assert.equal(f.documentCalls.length,1);assert.equal(f.downloads.length,1);
});
test('grouped order reuses the verified package archive of its sibling',async t=>{
 const f=await fixture(t,{grouped:true,archived:[[other,'PK-123',original]],warning:true});
 assert.equal((await f.service.recover(reference)).status,'complete');assert.equal(f.downloads.length,0);assert.equal(f.documentCalls.length,0);
 assert.equal((await f.db.query('SELECT count(*) n FROM temu_label_documents')).rows[0].n,2);
});
test('archive of an unrelated reference is not silently assigned to this order',async t=>{
 const f=await fixture(t,{archived:[[other,'PK-123',original]]});await assert.rejects(f.service.recover(reference),/autre commande/);assert.equal(f.downloads.length,0);assert.equal(f.documentCalls.length,0);
});
test('provider no longer reports printable but existing PDF remains complete',async t=>{
 const f=await fixture(t,{status:0,archived:[[reference,'PK-123',original]]});assert.equal((await f.service.recover(reference)).status,'complete');assert.equal(f.documentCalls.length,0);
});
test('unreadable archive is preserved and never downloaded again',async t=>{
 const f=await fixture(t,{archived:[[reference,'PK-123',Buffer.alloc(0)]]});await assert.rejects(f.service.recover(reference),/archivé illisible/);
 assert.equal(f.documentCalls.length,0);assert.equal(f.downloads.length,0);assert.equal((await f.db.query('SELECT octet_length(pdf) n FROM temu_label_documents')).rows[0].n,0);
});
test('no PDF ever saved remains an explicit provider refusal, without purchase',async t=>{
 const f=await fixture(t,{warning:true});const j=await f.service.recover(reference);assert.equal(j.status,'document_unavailable');assert.match(j.error,/colis déjà collecté/);assert.equal(f.downloads.length,0);
});

import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
const pastPdfWarning='Étiquette TEMU déjà achetée : PDF original indisponible (120018027). FedEx TRACK déjà collecté ; conserver cette expédition.';
test('delivered registered shipment retains PDF refusal as history, preserves ERPLAIN and independent blockers',()=>{
 const original={channel:'temu',tracking_status:'delivered',source_payload:{externalLabel:{active:true}},issue:pastPdfWarning,temu_job:{status:'external',error:pastPdfWarning},erp_live:{bl:{status:'in_preparation'}},erp_live_job:{status:'review',error:'Stock insuffisant'}};
 const projected=projectCurrentDiagnostics(structuredClone(original));
 assert.equal(projected.issue,null);assert.equal(projected.temu_job.error,null);assert.equal(projected.temu_pdf_archive_note,pastPdfWarning);
 assert.equal(projected.erp_live.bl.status,'in_preparation');assert.equal(projected.erp_live_job.error,'Stock insuffisant');assert.equal(original.issue,pastPdfWarning);
});
for(const variant of [{tracking_status:'in_transit'},{source_payload:{}},{issue:pastPdfWarning+' ; Stock insuffisant'},{issue:pastPdfWarning+' ; Produit introuvable'},{channel:'shopify'}])test('PDF history projection requires proof and does not hide unrelated blockers '+JSON.stringify(variant),()=>{
 const original={channel:'temu',tracking_status:'delivered',source_payload:{externalLabel:{active:true}},issue:pastPdfWarning,...variant};
 assert.equal(projectCurrentDiagnostics(structuredClone(original)).issue,original.issue);
});
