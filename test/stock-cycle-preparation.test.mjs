import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileFullStock} from '../src/stock-cycle.mjs';
function fixture({status='in_preparation',found=true,stockQuantity=1,blQuantity=1}={}){
 const item={type:'normal',quantity:1,variant:{id:101,sku:'PREP'},location:{id:202}};
 const o={id:'existing-order',items:[item],erp_live:{bc:{id:301},bl:{id:401},stockDocument:{id:501}}};
 const stock={id:501,label:'V3FS-existing-order',status:'completed',update_stock:true,notes:'LIVE : sortie de stock liée au BL BL401',line_items:[{...item,quantity:stockQuantity}]};
 const calls=[];const api={request:async(q)=>{calls.push(q);assert.match(q,/^query /,'no mutation may be called');
  if(q.includes('FindCycleStock'))return {StockRemovals:{data:found?[stock]:[],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('CheckCycleStock'))return {Order:{id:301,status:'active',update_stock:false,line_items:[item],shipping_orders:{data:[{id:401}],paginatorInfo:{hasMorePages:false}}},ShippingOrder:{id:401,label:'BL401',status,update_stock:false,line_items:[{...item,quantity:blQuantity}]}};
  throw Error('Unexpected query');
 }};return {o,api,calls};
}
test('existing completed stock is reused for an in-preparation BL without provider mutation',async()=>{
 const f=fixture();const result=await reconcileFullStock(f.api,f.o,{allowCreate:true});assert.equal(result.id,501);assert.equal(result.status,'completed');assert.equal(f.calls.length,2);assert.equal(f.o.erp_live.bl.id,401);
});
test('in-preparation does not waive mismatched stock quantities',async()=>{
 const f=fixture({stockQuantity:2});await assert.rejects(reconcileFullStock(f.api,f.o),/mouvement existant incompatible/);assert.equal(f.calls.length,2);
});
test('in-preparation does not waive mismatched BC/BL quantities',async()=>{
 const f=fixture({blQuantity:2});await assert.rejects(reconcileFullStock(f.api,f.o),/produits, lieux ou quantités différents/);
});
test('cancelled BL remains protected despite an existing stock document',async()=>{
 const f=fixture({status:'cancelled'});await assert.rejects(reconcileFullStock(f.api,f.o),/BC\/BL non conformes/);
});
test('in-preparation with missing stock never creates a new stock debit',async()=>{
 const f=fixture({found:false});await assert.rejects(reconcileFullStock(f.api,f.o,{allowCreate:true}),/sans mouvement identifié/);assert.equal(f.calls.length,2);
});
