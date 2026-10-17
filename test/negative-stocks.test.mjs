import {test} from 'node:test';
import assert from 'node:assert/strict';
import {negativeStocksService} from '../src/negative-stocks.mjs';
import {initializeNegativeStocks,negativeStocksHistory} from '../src/negative-stocks.mjs';
import {PGlite} from '@electric-sql/pglite';

test('history preserves complete server results and excludes interrupted scans',async()=>{
 const db=new PGlite();
 try{
  await initializeNegativeStocks(db);
  const reader={async page(page){return {scope:'erp-orders-with-bl-negative-available-v1',page:Number(page),lastPage:2,locationId:'7',unverified:1,checkedAt:new Date().toISOString(),rows:[{sku:'SKU'+page,available:-Number(page),onHand:0}]};}};
  const service=negativeStocksHistory(db,reader),user={email:'test@example.com'};
  const first=await service.scan({},user);
  assert.equal(first.saved,false);
  assert.equal((await service.list()).rows.length,0);
  await assert.rejects(()=>service.get(first.runId),/introuvable/);
  await assert.rejects(()=>service.scan({page:2,runId:first.runId},{email:'other@example.com'}),/expirée/);
  const last=await service.scan({page:2,runId:first.runId},user);
  assert.equal(last.saved,true);
  const saved=await negativeStocksHistory(db,reader).get(first.runId);
  assert.deepEqual(saved.snapshot.rows.map(row=>row.available),[-1,-2]);
  assert.equal(saved.snapshot.unverified,2);
  assert.equal((await service.list()).rows[0].product_count,2);
  await assert.rejects(()=>service.scan({page:2,runId:first.runId},user),/expirée/);
  const changing=await service.scan({},user);
  reader.page=async()=>({scope:'erp-orders-with-bl-negative-available-v1',page:2,lastPage:2,locationId:'8',rows:[],unverified:0});
  await assert.rejects(()=>service.scan({page:2,runId:changing.runId},user),/Emplacement modifié/);
  assert.equal((await service.list()).rows.length,1);
 }finally{await db.close();}
});

const line=(id,available=-1,onHand=5,extra={})=>({id,quantity:1,label:'Produit BL',location:{id:'7',label:'Default location'},variant:{id:'v'+id,sku:'SKU'+id,track_inventory:true,product:{default_supplier:{label:'Principal'}},stock_levels:{data:[{location:{id:'7'},available,on_hand:onHand},{location:{id:'8'},available:-100,on_hand:-100}],paginatorInfo:{hasMorePages:false}}},...extra});
const document=(id,lines,status='ready_to_ship')=>({id,label:'CO'+id,status,line_items:lines,shipping_orders:{data:[{id:'bl'+id,label:'SHO'+id,status:'ready_to_ship'}],paginatorInfo:{hasMorePages:false}}});
function reader(documents,lastPage=1){return negativeStocksService({verify:async()=>{},request:async(query)=>{assert.match(query,/^query /);assert.match(query,/Orders/);return {Orders:{data:documents,paginatorInfo:{lastPage}}};}},'',{location:async()=>'7'});}

test('reports existing BL lines with negative available stock, preserving BL quantities and suppliers',async()=>{
 const shared=line(1),second={...shared,quantity:3};
 const result=await reader([document(10,[shared,line(2,0,-5),line(3,2,0)]),document(11,[second])],2).page();
 assert.deepEqual(result.rows.map(row=>[row.bcLabel,row.blLabel,row.sku,row.orderQuantity,row.available,row.onHand,row.supplier]),[['CO10','SHO10','SKU1',1,-1,5,'Principal'],['CO11','SHO11','SKU1',3,-1,5,'Principal']]);
 assert.equal(result.lastPage,2);assert.equal(result.scope,'erp-orders-with-bl-negative-available-v1');
});

test('excludes cancelled/unpublished BL, fees, other warehouses and unknown stock',async()=>{
 const malformed=line(5);malformed.variant.stock_levels.paginatorInfo.hasMorePages=true;
 const missingTracking=line(6);delete missingTracking.variant.track_inventory;
 const result=await reader([document(1,[line(1)],'cancelled'),document(2,[line(2)],'unpublished'),document(3,[line(3,-1,0,{location:{id:'8'}}),line(4,null,0),malformed,missingTracking,{id:'fee',quantity:1,variant:null}])]).page();
 assert.equal(result.rows.length,0);assert.equal(result.unverified,3);
});

test('incomplete BL pagination fails instead of claiming an empty report',async()=>{
 await assert.rejects(()=>reader([],undefined).page('0'),/invalide/);
 await assert.rejects(()=>reader([],null).page(),/incomplète/);
 assert.equal((await reader([],0).page()).rows.length,0);
});

test('associated supplier fallback is preserved',async()=>{
 const product=line(1);product.variant.product={};product.variant.suppliers=[{supplier:{label:'Associe'}},{supplier:{label:'Associe'}}];
 assert.equal((await reader([document(1,[product])]).page()).rows[0].supplier,'Associe');
});

test('ERP command CO015844 with -20 available is included only with a created BL',async()=>{
 const product=line(1,-20,4);product.quantity=10;product.variant.sku='BT-0022-33B-SMS';
 const order={...document(15844,[product],'active'),label:'CO015844',external_reference:'PO-test'};
 const noDelivery={...document(15845,[line(2)],'active'),shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
 const result=await reader([order,noDelivery]).page();
 assert.equal(result.rows[0].bcLabel,'CO015844');assert.equal(result.rows[0].available,-20);assert.equal(result.rows[0].orderQuantity,10);
 assert.equal(result.rows.length,1);
 const cancelledDelivery={...noDelivery,shipping_orders:{data:[{id:'cancelled-bl',label:'SHO-cancelled',status:'cancelled'},{id:'draft-bl',label:'SHO-draft',status:'unpublished'}],paginatorInfo:{hasMorePages:false}}};
 assert.equal((await reader([cancelledDelivery]).page()).rows.length,0);
});

test('all associated BL pages are read before a command is reported',async()=>{
 const order=document(1,[line(1)]);order.shipping_orders.paginatorInfo.hasMorePages=true;
 const api={verify:async()=>{},request:async(query,variables)=>{
  if(query.includes('V3NegativeStockOrders('))return {Orders:{data:[order],paginatorInfo:{lastPage:1}}};
  assert.equal(variables.page,2);return {Order:{id:1,shipping_orders:{data:[{id:'extra',label:'SHO-extra',status:'ready_to_ship'}],paginatorInfo:{hasMorePages:false}}}};
 }};
 const result=await negativeStocksService(api,'',{location:async()=>'7'}).page();
 assert.equal(result.rows[0].blLabel,'SHO1 ; SHO-extra');
});

test('BL, quantity and negative availability are numeric/text values in Excel',async()=>{
 const {exportNegativeStocks}=await import('../src/negative-stocks-export.mjs');
 const {default:ExcelJS}=await import('exceljs');
 const rows=(await reader([document(10,[line(1)])]).page()).rows;
 const book=new ExcelJS.Workbook();await book.xlsx.load(await exportNegativeStocks(rows));
 const sheet=book.worksheets[0];
 assert.equal(sheet.getCell('A2').value,'CO10');assert.equal(sheet.getCell('B2').value,'SHO10');assert.equal(sheet.getCell('F2').value,1);assert.equal(sheet.getCell('G2').value,-1);assert.equal(sheet.getCell('I2').value,'Default location');
});
