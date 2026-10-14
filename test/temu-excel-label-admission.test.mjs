import test from 'node:test';
import assert from 'node:assert/strict';
import {assertExcelLabelPreparation} from '../src/temu-excel-label-admission.mjs';
const order={id:'o',channel:'temu',reference:'PO-1-2',source_payload:{},erp_live:{bc:{id:'bc'},bl:{id:'bl',status:'ready_to_ship'}},resolution_pending_resume:true};
const db={query:async()=>({rows:[]})};
test('published BL is independent of legacy import job ids and completion flags',async()=>{
 await assertExcelLabelPreparation(db,order);
 await assert.rejects(assertExcelLabelPreparation(db,{...order,erp_live:{bc:{id:'bc'},bl:{id:'bl',status:'unpublished'}}}),/demande de préparation Excel absente/);
});
test('operational holds remain effective with a published BL',async()=>{
 for(const change of [{simulation:true},{erp_live:{...order.erp_live,bc:{id:'bc',status:'cancelled'}}},{archived:true},{partial_mode:true},{label_status:'cancelled'},{tracking_status:'shipped'},{tracking_status:'delivered'},{transport_choice:'gofo'},{duplicate_of:'other'},{suspension:{active:true}},{source_payload:{externalLabel:{active:true}}},{source_payload:{visibilityHold:true}},{source_payload:{erplainValidationHold:true}}])await assert.rejects(assertExcelLabelPreparation(db,{...order,...change}),JSON.stringify(change));
});
test('unrelated review blocks; only the original reservation error can be superseded by a published BL',async()=>{
 const o={...order,source_payload:{temuExcelPreparation:{jobId:'import'}}};
 for(const review of [{id:'other',action:'resume',error:'BC · Quantités réservées non confirmées'},{id:'import',action:'resume',error:'Annulation à vérifier'},{id:'import',action:'address',error:'BC · Quantités réservées non confirmées'}]){
  const db={query:async sql=>({rows:sql.includes('UNION ALL')?[]:[review]})};
  await assert.rejects(assertExcelLabelPreparation(db,o),/intervention à vérifier/);
 }
});
