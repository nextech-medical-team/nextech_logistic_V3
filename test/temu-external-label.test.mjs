import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {externalLabelInput,registerExternalLabel,hasExternalLabel,readExternalTemuTracking} from '../src/temu-external-label.mjs';
import {assertDirectCarrierAllowed} from '../src/temu-label-policy.mjs';
import {prepareLabel} from '../src/workflow.mjs';
import {temuShipping} from '../src/temu-shipping.mjs';
import {buildLabelDownload} from '../src/label-downloads.mjs';
import {PDFDocument} from 'pdf-lib';

test('external declaration validates identity, explicit coverage and optional PDF',()=>{
 const b={carrier:'FedEx',tracking:'123456789\n987654321',confirmed:true};
 assert.equal(externalLabelInput(b).tracking.length,2);
 for(const change of [{confirmed:false},{tracking:''},{tracking:'123\n123'},{carrier:'<bad>'},{pdf:Buffer.from('not PDF').toString('base64')}])assert.throws(()=>externalLabelInput({...b,...change}));
 assert.ok(externalLabelInput({...b,pdf:Buffer.from('%PDF-1.4 test').toString('base64')}).pdf);
});
test('export uses only the external PDF, preserving old labels without printing them',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 const o={id:'export-external',channel:'temu',reference:'PO-EXTERNAL',source_payload:{externalLabel:{active:true,hasPdf:true,carrier:'FedEx',tracking:['123']}}};const read=[];
 const db={async query(sql){read.push(sql);if(sql.includes('FROM orders'))return {rows:[o]};if(sql.includes('temu_external_label_documents'))return {rows:[{pdf:bytes}]};throw Error('Unexpected old label read');}};
 const job={};await buildLabelDownload(db,{ids:[o.id]},job);assert.equal(job.pages,1);assert.equal(job.exportSources[0].source.carrier,'FedEx');assert.ok(!read.some(s=>s.includes('FROM temu_label_documents')||s.includes('FROM carrier_documents')));
});
test('declaration is local, idempotent, archives refusal and preserves old documents and independent blocks',async()=>{
 const db=await openDatabase();try{
 await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_choice text; CREATE TABLE temu_label_jobs(reference text PRIMARY KEY,status text,error text,plan jsonb,packages jsonb,result jsonb,updated_at timestamptz DEFAULT now()); CREATE TABLE carrier_jobs(order_id text,status text,updated_at timestamptz DEFAULT now()); CREATE TABLE extra_parcels(order_id text,status text);CREATE TABLE temu_label_documents(reference text,pdf bytea);`);
 await db.query("INSERT INTO orders(id,channel,reference,recipient,address,source_payload,label_status,issue,tracking_status) VALUES('external-test','temu','PO-053-19027229409911181','Test','{}','{}','blocked','Stock insuffisant','not_shipped')");
 await db.query("INSERT INTO temu_label_jobs VALUES('PO-053-19027229409911181','shipment_error','caractères refusés','{}','[\"PK-OLD\"]','{\"old\":true}',now())");
 await db.query("INSERT INTO temu_label_documents VALUES('PO-053-19027229409911181',$1)",[Buffer.from('existing PDF')]);
 const input={id:'external-test',carrier:'FedEx',tracking:'123456789',confirmed:true,pdf:Buffer.from('%PDF-1.4 external').toString('base64')};
 assert.equal((await registerExternalLabel(db,input,{email:'test@example.invalid'})).saved,true);
 assert.equal((await registerExternalLabel(db,input,{email:'test@example.invalid'})).alreadySaved,true);
 await assert.rejects(()=>registerExternalLabel(db,{...input,tracking:'different'},{email:'test@example.invalid'}),/déjà/);
 const o=(await db.query("SELECT * FROM orders WHERE id='external-test'")).rows[0];
 assert.equal(o.issue,'Stock insuffisant');assert.equal(o.label_status,'blocked');assert.equal(o.tracking_status,'not_shipped');assert.equal(hasExternalLabel(o),true);
 const j=(await db.query("SELECT * FROM temu_label_jobs")).rows[0];assert.equal(j.status,'external');assert.equal(j.error,null);assert.equal(j.result.old,true);assert.equal(j.result.externalLabelResolution.previousError,'caractères refusés');assert.deepEqual(j.packages,['PK-OLD']);
 assert.equal(Buffer.from((await db.query('SELECT pdf FROM temu_label_documents')).rows[0].pdf).toString(),'existing PDF');
 assert.throws(()=>assertDirectCarrierAllowed({...o,transport_choice:'gls'},'gls'),/externe/);
 await db.query("INSERT INTO orders(id,channel,reference,recipient,address,source_payload,label_status,issue,tracking_status) VALUES('external-error','temu','PO-ERROR','Test','{}','{}','blocked','TEMU · Adresse : caractères refusés','not_shipped')");
 await registerExternalLabel(db,{...input,id:'external-error',pdf:null},{email:'test@example.invalid'});
 const released=(await db.query("SELECT label_status,issue,tracking_status FROM orders WHERE id='external-error'")).rows[0];assert.equal(released.label_status,'ready');assert.equal(released.issue,null);assert.equal(released.tracking_status,'not_shipped');
 await prepareLabel({query(){throw Error('Unexpected preparation');}},o);
 const queries=[];const trackingDB={async query(sql,args){queries.push({sql,args});return {rows:[]};}};
 await readExternalTemuTracking(trackingDB,o,{read:async()=>{throw Error('tracking unavailable');}},{shipmentInfoDTO:[{packageSn:'PK-EXTERNAL'}]});
 assert.equal(queries.length,1);assert.equal(JSON.parse(queries[0].args[1]).trackingErrors.length,1);assert.ok(!queries[0].sql.includes("status='api_error'"));
 }finally{await db.close();}
});
test('stale quote, direct buy and old recovery cannot recreate an external order label',async()=>{
 const external={channel:'temu',source_payload:{externalLabel:{active:true}}};let calls=0;
 const db={async query(sql){return {rows:sql.includes('FROM orders')?[external]:[{reference:'PO-053-19027229409911181',status:'external'}]};}};
 const api={read(){calls++;throw Error('Unexpected TEMU read');},buy(){calls++;throw Error('Unexpected purchase');}};
 const service=temuShipping(db,api);
 await assert.rejects(()=>service.prepare('PO-053-19027229409911181'),/externe/);
 await assert.rejects(()=>service.buy('PO-053-19027229409911181','stale',1),/externe/);
 assert.equal((await service.recover('PO-053-19027229409911181')).status,'external');assert.equal(calls,0);
});
test('TEMU physical events mark delivered only when every declared parcel is covered',async()=>{
 const queries=[],db={async query(sql,args){queries.push({sql,args});return {rows:[]};}};
 const o={id:'follow-up',reference:'PO-053-19027229409911181',channel:'temu',tracking_status:'not_shipped',source_payload:{externalLabel:{active:true,tracking:['123','456']}}};
 const api={async read(method,{packageSn}){return {trackingNum:packageSn==='PK-1'?'123':'456',trackingInfo:[{logisticsStatus:'DELIVERED',statusText:'Delivered',logisticsUpdatedAt:'1700000000000'}]};}};
 await readExternalTemuTracking(db,o,api,{shipmentInfoDTO:[{packageSn:'PK-1'}]});assert.equal(queries.find(q=>q.sql.includes('UPDATE orders')).args[1],'shipped');
 queries.length=0;await readExternalTemuTracking(db,o,api,{shipmentInfoDTO:[{packageSn:'PK-1'},{packageSn:'PK-2'}]});assert.equal(queries.find(q=>q.sql.includes('UPDATE orders')).args[1],'delivered');
});
