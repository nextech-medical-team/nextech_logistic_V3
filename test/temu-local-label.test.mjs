import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {labelIdentity,localLabelPdf,localLabels} from '../scripts/temu-local-label.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const order={id:'test-id',channel:'temu',reference:'PO-TEST',recipient:'Łukasz Øster',address:{street:'Rue exemple',postal:'1000',city:'Test',country:'DK'}};
const state={companyId:101406,complete:true,version:2,bc:{id:1,label:'BC1'},bl:{id:2,label:'BL2',status:'pending'},pricing:{items:[{variant:{id:3},description:'SKU',quantity:1}]}};
test('label requires confirmed TEST documents and is visibly a simulation',async()=>{
 assert.throws(()=>labelIdentity(order,{...state,companyId:100174}),/TEST/);assert.throws(()=>labelIdentity(order,{...state,pending:'bl'}),/TEST/);assert.throws(()=>labelIdentity(order,{...state,complete:false}),/TEST/);
 const pdf=await PDFDocument.load(await localLabelPdf(order,state));assert.match(pdf.getTitle(),/ETIQUETTE TEST/);assert.match(pdf.getSubject(),/Ne pas expédier/);assert.equal(pdf.getPageCount(),1);
});
test('label persists, reuses same document, and binds BC/BL identity',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'temu-label-'));t.after(()=>rm(directory,{recursive:true,force:true}));const db={query:async()=>({rows:[order]})},documents={state:async()=>state};
 const service=localLabels({db,documents,directory});assert.equal(await service.info(order,state),null);const first=await service.create(order.id),bytes=await service.bytes(order.id);const second=await localLabels({db,documents,directory}).create(order.id);assert.equal(first.key,second.key);assert.deepEqual(await service.bytes(order.id),bytes);assert.notEqual(labelIdentity(order,{...state,bl:{...state.bl,id:8}}),first.key);
});
