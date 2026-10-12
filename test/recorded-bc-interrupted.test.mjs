import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyInterruptedDocuments} from '../src/erplain-interrupted.mjs';
const fixture=()=>{
 const line={type:'normal',quantity:2,price:5,tax_amount:2,variant:{id:'10',sku:'BC-PRODUCT'},location:{id:'20'}};
 const bl={id:'2',label:'SHO00744003',status:'ready_to_ship',update_stock:false,line_items:[line]};
 const bc={id:'1',status:'active',update_stock:false,total:12,currency:{label:'EUR'},tax_type:'exclusive',line_items:[line],shipping_orders:{data:[{id:'2'}],paginatorInfo:{hasMorePages:false}}};
 const stock={id:'3',label:'V3FS-o',status:'completed',update_stock:true,notes:'LIVE : sortie de stock liée au BL '+bl.label,line_items:[line]};
 const o={id:'o',channel:'temu',source_payload:{temuAmountsError:'unauthorized'},erp_live:{bc:{id:'1'},bl:{id:'2',label:bl.label},stockDocument:{id:'3'}}};
 const queries=[];
 const api={verify:async()=>{},request:async(q)=>{
  assert.match(q,/^query /);queries.push(q);
  if(q.includes('StockRemoval(id:'))return {StockRemoval:stock};
  if(q.includes('FindCycleStock'))return {StockRemovals:{data:[stock],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('CheckCycleStock'))return {Order:bc,ShippingOrder:bl};
  if(q.includes('V3InterruptedDocuments'))return {Order:bc};
  assert.fail('Unexpected provider request: '+q);
 }};
 const lines=[{source_sku:'MARKETPLACE-PRODUCT',mapped_sku:'OTHER',quantity:999,source_qty:1,target_qty:100}];
 return {api,o,bc,bl,stock,queries,lines};
};
test('interrupted preparation reuses actual BC and stock without marketplace or global mapping comparison',async()=>{
 const f=fixture(),r=await verifyInterruptedDocuments(f.api,f.o,f.lines);
 assert.equal(r.stock.id,'3');assert.equal(r.pricing.authority,'recorded_erplain_bc');assert.equal(f.o.items[0].variant.id,'10');assert.equal(f.o.items[0].quantity,2);
 assert.ok(f.queries.every(q=>!q.includes('mutation')));assert.equal(f.o.source_payload.temuAmountsError,'unauthorized');
});
for(const kind of ['cancelled-bc','cancelled-bl','incompatible-stock'])test('interrupted read keeps genuine document protection: '+kind,async()=>{
 const f=fixture();if(kind==='cancelled-bc')f.bc.status='cancelled';if(kind==='cancelled-bl')f.bl.status='cancelled';if(kind==='incompatible-stock')f.stock.line_items=[{...f.stock.line_items[0],quantity:1}];
 await assert.rejects(verifyInterruptedDocuments(f.api,f.o,f.lines),/BC|Stock Erplain/);
 assert.ok(f.queries.every(q=>q.startsWith('query')));
});
