import test from 'node:test';
import assert from 'node:assert/strict';
import {completedExcelPreparation} from '../src/temu-excel-purchase-admission.mjs';
const order={source_payload:{temuExcelPreparation:{jobId:'import'}}};
const original={id:'import',action:'resume',status:'complete',result:{erpOnly:true}};
const retry={id:'retry',action:'resume-erp',status:'complete',result:{erpOnly:true}};
const check=jobs=>completedExcelPreparation({query:async()=>({rows:jobs})},order);
test('completed BL resume can follow the completed Excel import',async()=>{
 assert.equal(await check([retry,original]),true);
 assert.equal(await check([original]),true);
});
test('unrelated, incomplete and ambiguous resolutions remain held',async()=>{
 for(const changes of [{status:'review'},{status:'queued'},{error:'Stock insuffisant'},{action:'choose-carrier'},{result:{erpOnly:true,readOnly:true}},{result:{erpOnly:true,partialRemainder:true}},{result:{erpOnly:true,manualPricing:true}},{result:{erpOnly:true,equivalent:true}}])assert.equal(await check([{...retry,...changes},original]),false);
 assert.equal(await check([retry]),false);
 assert.equal(await check([retry,{...original,status:'review'}]),false);
 assert.equal(await check([retry,{id:'other',status:'running'},original]),false);
});
