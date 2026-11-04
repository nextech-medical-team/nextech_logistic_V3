import test from 'node:test';import assert from 'node:assert/strict';
import {parentAllocatedLotLines,historicalParentOrFifoLines} from '../src/partial-parent-lots.mjs';
import {recoverPaidTemuLabel} from '../src/recover-paid-temu-label.mjs';

const parent=()=>({id:'1',status:'active',update_stock:true,line_items:[{id:'10',quantity:10,variant:{id:'2',has_batch_numbers:true},location:{id:'3'},batch_numbers:[{quantity:10,batch_number:{id:'4'}}]}],shipping_orders:{data:[{id:'20',status:'shipped',line_items:[{parent_id:'10',quantity:4,variant:{id:'2'},location:{id:'3'},batch_numbers:[{quantity:4,batch_number:{id:'4'}}]}]}],paginatorInfo:{hasMorePages:false}}});
const chosen=q=>[{lineId:'10',variantId:'2',locationId:'3',quantity:q}];
test('parent lots retain shipped quantities and refuse an over-allocation',()=>{
 assert.deepEqual(parentAllocatedLotLines(parent(),chosen(6))[0].batch_numbers,[{batch_number:{id:'4'},quantity:6}]);
 assert.throws(()=>parentAllocatedLotLines(parent(),chosen(7)),/insuffisant/);
});
test('unallocated historical parent uses FIFO only for its verified remainder',async()=>{
 const bc=parent();bc.line_items[0].batch_numbers=[];
 let calls=0;const allocate=async rows=>{calls++;return rows.map(l=>({...l,batch_numbers:[{batch_number:{id:'5'},quantity:l.quantity}]}));};
 const result=await historicalParentOrFifoLines(bc,chosen(6),{allocate});assert.equal(calls,1);assert.equal(result[0].batch_numbers[0].quantity,6);
 await assert.rejects(historicalParentOrFifoLines(bc,chosen(7),{allocate}),/reliquat/);assert.equal(calls,1);
});
test('paid TEMU recovery refuses foreign ownership before any local write',async()=>{
 const db={query:async()=>({rows:[{packages:['PK-1']}]}),transaction:()=>assert.fail('no mutation')};
 const service={recover:async()=>({status:'complete',result:{packageInfoResultList:[{packageSn:'PK-1',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:'OTHER'}]}]}})};
 await assert.rejects(recoverPaidTemuLabel(db,service,{id:'o',reference:'PO-1'},'read failed'),/identité du colis/);
});
test('paid TEMU recovery refuses missing archived PDF before any local write',async()=>{
 const db={query:async sql=>({rows:sql.includes('SELECT packages')?[{packages:['PK-1']}]:[]}),transaction:()=>assert.fail('no mutation')};
 const service={recover:async()=>({status:'complete',result:{packageInfoResultList:[{packageSn:'PK-1',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:'PO-1'}]}]}})};
 await assert.rejects(recoverPaidTemuLabel(db,service,{id:'o',reference:'PO-1'},'read failed'),/PDF archivé incomplet/);
});
