import test from 'node:test';
import assert from 'node:assert/strict';
import {assertResumeStock} from '../src/resume-stock-policy.mjs';

const order={erp_live:{bc:{id:'10'}}};
const bc={id:'10',status:'active',update_stock:true};
const lines=[{type:'normal',quantity:270,available:-270,on_hand:-270,reserved_quantity:0,location:{id:'1'},variant:{id:'2',sku:'X',track_inventory:true}}];
test('already debited BC resumes with a fresh ledger proof despite negative available stock',async()=>{
 const proof={bcId:'10',stockOnBc:true};let reads=0;
 const result=await assertResumeStock({},order,bc,lines,{prove:async(api,o)=>{reads++;assert.deepEqual(o.items,lines);return proof;},assertAvailable:()=>assert.fail('must not require a second debit')});
 assert.equal(reads,1);assert.deepEqual(result,{stockOnBc:true,proof});
});
test('incomplete or uncertain historical ledger never resumes',async()=>{
 await assert.rejects(assertResumeStock({},order,bc,lines,{prove:async()=>{throw Error('journal incomplet');}}),/journal incomplet/);
 await assert.rejects(assertResumeStock({},order,bc,lines,{prove:async()=>({bcId:'20',stockOnBc:true})}),/Débit historique/);
});
test('BC without a stock debit still requires sufficient current stock',async()=>{
 await assert.rejects(assertResumeStock({},order,{...bc,update_stock:false},lines),/stock insuffisant/);
});
test('unknown policy, different identity and inactive BC fail before the ledger read',async()=>{
 for(const candidate of [{...bc,update_stock:null},{...bc,id:'11'},{...bc,status:'cancelled'}])await assert.rejects(assertResumeStock({},order,candidate,lines,{prove:()=>assert.fail('unexpected read')}));
});
