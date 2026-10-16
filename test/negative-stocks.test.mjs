import {test} from 'node:test';
import assert from 'node:assert/strict';
import {negativeStocksService} from '../src/negative-stocks.mjs';
import {initializeNegativeStocks,negativeStocksHistory} from '../src/negative-stocks.mjs';
import {PGlite} from '@electric-sql/pglite';

test('history preserves complete server results and excludes interrupted scans',async()=>{
 const db=new PGlite();
 try{
  await initializeNegativeStocks(db);
  const reader={async page(page){return {page:Number(page),lastPage:2,locationId:'7',unverified:1,checkedAt:new Date().toISOString(),rows:[{sku:'SKU'+page,available:-Number(page),onHand:0}]};}};
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
  reader.page=async()=>({page:2,lastPage:2,locationId:'8',rows:[],unverified:0});
  await assert.rejects(()=>service.scan({page:2,runId:changing.runId},user),/Emplacement modifié/);
  assert.equal((await service.list()).rows.length,1);
 }finally{await db.close();}
});

test('negative quantities are retained at the configured location only',async()=>{
 const variant=(id,available,onHand,extra={})=>({id,sku:'SKU'+id,active:true,track_inventory:true,product:{active:true,label:'Produit'},stock_levels:{data:[{location:{id:'7'},available,on_hand:onHand},{location:{id:'8'},available:-100,on_hand:-100}],paginatorInfo:{hasMorePages:false}},...extra});
 const api={verify:async()=>{},request:async()=>({Variants:{data:[variant(1,'-2',3),variant(2,4,-1),variant(3,0,0),variant(4,-3,-3,{active:false}),variant(5,null,null),variant(6,-1,-1,{stock_levels:{data:[],paginatorInfo:{hasMorePages:true}}})],paginatorInfo:{lastPage:2}}})};
 const service=negativeStocksService(api,'',{location:async()=>'7'});
 const result=await service.page('1');
 assert.deepEqual(result.rows.map(r=>[r.sku,r.available,r.onHand]),[['SKU1',-2,3],['SKU2',4,-1]]);
 assert.equal(result.unverified,2);assert.equal(result.lastPage,2);
 await assert.rejects(()=>service.page('-1'),/invalide/);
});

test('an incomplete catalog fails instead of claiming no negative stocks',async()=>{
 const service=negativeStocksService({verify:async()=>{},request:async()=>({Variants:{data:[],paginatorInfo:{}}})},'',{location:async()=>'7'});
 await assert.rejects(()=>service.page(),/incomplète/);
});

test('supplier uses the primary supplier then associated suppliers without inventing missing data',async()=>{
 const variant=(id,product,suppliers)=>({id,sku:String(id),active:true,track_inventory:true,product,suppliers,stock_levels:{data:[{location:{id:7},available:-1,on_hand:0}],paginatorInfo:{hasMorePages:false}}});
 const api={verify:async()=>{},request:async()=>({Variants:{data:[variant(1,{default_supplier:{label:'Principal'}},[{supplier:{label:'Autre'}}]),variant(2,{},[{supplier:{label:'Associe'}},{supplier:{label:'Associe'}}]),variant(3,{},[])],paginatorInfo:{lastPage:1}}})};
 const result=await negativeStocksService(api,'',{location:async()=>'7'}).page();
 assert.deepEqual(result.rows.map(row=>row.supplier),['Principal','Associe',null]);
});
