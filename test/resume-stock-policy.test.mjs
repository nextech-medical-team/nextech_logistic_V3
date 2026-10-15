import test from 'node:test';
import assert from 'node:assert/strict';
import {assertResumeStock} from '../src/resume-stock-policy.mjs';

const order={erp_live:{bc:{id:'10'}}};
const bc={id:'10',status:'active',update_stock:true};
const lines=[{type:'normal',quantity:270,available:-270,on_hand:-270,reserved_quantity:0,location:{id:'1'},variant:{id:'2',sku:'X',track_inventory:true}}];
test('historical debit never bypasses insufficient current stock before a new BL',async()=>{
 await assert.rejects(assertResumeStock({},order,bc,lines,{prove:()=>assert.fail('stock must block before historical proof')}),/stock insuffisant/);
});
test('existing BL resume does not require current stock a second time',async()=>{
 const proof={bcId:'10',stockOnBc:true};
 const result=await assertResumeStock({},{erp_live:{bc:{id:'10'},bl:{id:'20'}}},bc,lines,{prove:async()=>proof,assertAvailable:()=>assert.fail('existing BL')});
 assert.deepEqual(result,{stockOnBc:true,proof});
});
test('incomplete or uncertain historical ledger never resumes',async()=>{
 const stocked=lines.map(l=>({...l,available:270,on_hand:270}));
 await assert.rejects(assertResumeStock({},order,bc,stocked,{prove:async()=>{throw Error('journal incomplet');}}),/journal incomplet/);
 await assert.rejects(assertResumeStock({},order,bc,stocked,{prove:async()=>({bcId:'20',stockOnBc:true})}),/Débit historique/);
});
test('BC without a stock debit still requires sufficient current stock',async()=>{
 await assert.rejects(assertResumeStock({},order,{...bc,update_stock:false},lines),/stock insuffisant/);
});
test('unknown policy, different identity and inactive BC fail before the ledger read',async()=>{
 for(const candidate of [{...bc,update_stock:null},{...bc,id:'11'},{...bc,status:'cancelled'}])await assert.rejects(assertResumeStock({},order,candidate,lines,{prove:()=>assert.fail('unexpected read')}));
});
