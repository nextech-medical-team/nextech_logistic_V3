import test from 'node:test';
import assert from 'node:assert/strict';
import {readIncomingReceipts,receiptDate} from '../src/incoming-receipts.mjs';
import {stockInformationService} from '../src/stock-information.mjs';
const product={sku:'A',variantId:'1',locationId:'10',incoming:20};
const line=(id,quantity,date)=>({id,sku:'A',variant:{id:1},location:{id:10},undelivered_quantity:quantity,shipping_at:date,drop_shipping:0});
const purchase=lines=>({id:1,status:'active',update_incoming:true,drop_shipping:false,shipping_at:'2026-10-20',line_items:lines});
const api=pages=>({request:async(q,{where,page})=>{assert.match(q,/^query V3IncomingReceipts/);assert.deepEqual(where.AND.map(x=>x.column),['VARIANT_ID','LOCATION_ID','STATUS','UPDATE_INCOMING']);return {Purchases:pages[page-1]};}});
const page=(data,hasMorePages=false)=>({data,paginatorInfo:{hasMorePages}});
test('partial receipts use remaining quantities, line dates, and sorted arrival groups',async()=>{
 const r=await readIncomingReceipts(api([page([purchase([line(1,5,'2026-10-22'),line(2,10,null),line(3,5,'2026-10-22')])])]),product);
 assert.equal(r.status,'verified');assert.deepEqual(r.receipts,[{date:'2026-10-20',quantity:10},{date:'2026-10-22',quantity:10}]);
});
test('other locations, products, direct deliveries, cancelled and received purchases are excluded',async()=>{
 const irrelevant=[{...line(2,99,null),location:{id:11}},{...line(3,99,null),variant:{id:2}},{...line(4,99,null),drop_shipping:1},line(5,0,null)];
 const r=await readIncomingReceipts(api([page([purchase([line(1,20,null),...irrelevant]),{...purchase([line(6,99,null)]),status:'cancelled'},{...purchase([line(7,99,null)]),drop_shipping:true}])]),product);
 assert.equal(r.matchedQuantity,20);assert.equal(r.status,'verified');
});
test('missing, invalid and unmatched dates never promise a complete return',async()=>{
 assert.equal(receiptDate('2026-02-30'),null);assert.equal(receiptDate('2028-02-29'),'2028-02-29');
 const r=await readIncomingReceipts(api([page([purchase([line(1,10,'2026-02-30'),line(2,5,'2026-10-21')])])]),product);
 assert.equal(r.status,'partial');assert.equal(r.undatedQuantity,10);assert.deepEqual(r.receipts,[{date:'2026-10-21',quantity:5}]);
});
test('pagination is complete or fails closed, duplicated lines never double count',async()=>{
 const r=await readIncomingReceipts(api([page([purchase([line(1,10,null)])],true),page([purchase([line(2,10,null)])])]),product);assert.equal(r.status,'verified');
 await assert.rejects(readIncomingReceipts(api(Array(5).fill(page([],true))),product));
 await assert.rejects(readIncomingReceipts(api([page([purchase([line(1,10,null),line(1,10,null)])])]),product));
 await assert.rejects(readIncomingReceipts(api([page([purchase([line(1,null,null)])])]),product));
});
test('no incoming stock performs no purchase reads',async()=>{
 const unused={request:()=>assert.fail('unexpected read')};assert.equal((await readIncomingReceipts(unused,{...product,incoming:0})).status,'none');assert.equal((await readIncomingReceipts(unused,{...product,incoming:null})).status,'unverified');
});
test('inconsistent purchase totals cannot promise more units than the incoming stock',async()=>{
 await assert.rejects(readIncomingReceipts(api([page([purchase([line(1,30,null)])])]),product));
});
test('date provider failure preserves the verified incoming quantity and stock',async()=>{
 const db={query:async()=>({rows:[]})};
 const provider={verify:async()=>{},request:async(q)=>{
  if(q.includes('V3IncomingReceipts'))throw Error('quota');
  return {Variants:{data:[{id:1,sku:'A',active:true,track_inventory:true,product:{active:true,label:'A'},stock_levels:{data:[{location:{id:10},available:0,on_hand:0,incoming:20}],paginatorInfo:{hasMorePages:false}}}],paginatorInfo:{hasMorePages:false}}};
 }};
 const r=await stockInformationService(db,provider,'',{location:async()=> '10'}).get('A',{includeIncomingDates:true});assert.equal(r.original.incoming,20);assert.equal(r.original.available,0);assert.equal(r.original.incomingReceipts.status,'unverified');
});
