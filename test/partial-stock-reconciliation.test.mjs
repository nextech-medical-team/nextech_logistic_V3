import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {refreshPartialFromErplain} from '../src/partial-erplain-sync.mjs';
import {assertStockResolved} from '../src/stock-gate.mjs';

async function fixture({mismatch=false,native=false,concurrent=false,incomplete=false,missing=false,ambiguous=false}={}){
 const e=new PGlite();
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,partial_mode boolean,erp_live jsonb); CREATE TABLE erp_live_jobs(order_id text,status text,updated_at timestamptz); CREATE TABLE resolution_jobs(order_id text,status text); CREATE TABLE carrier_jobs(order_id text,status text); CREATE TABLE partial_deliveries(id text PRIMARY KEY,order_id text,status text,stage text,selection jsonb,bl jsonb,stock_document jsonb,error text,tracking jsonb,created_at timestamptz default now(),updated_at timestamptz default now());`);
 const line={id:'4',type:'normal',quantity:2,price:1,tax_amount:0,variant:{id:'60',sku:'SKU',track_inventory:true},location:{id:'70'}};
 const bl={id:'30',label:'SH000745465',status:'pending',created_at:'2026-10-19 10:00:00',update_stock:false,line_items:[{...line,id:'5',parent_id:'4'}]};
 const bc={id:'10',created_at:'2026-10-09 10:00:00',status:'active',update_stock:native,total:2,currency:{label:'EUR'},line_items:[line],shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}};
 await e.query(`INSERT INTO orders VALUES('o','PHARM828087','tender',true,$1)`,[JSON.stringify({bc:{id:'10'}})]);
 await e.query(`INSERT INTO partial_deliveries(id,order_id,status,stage,selection,bl,tracking) VALUES('d','o','ready','ready',$1,$2,'["tracking-kept"]')`,[JSON.stringify([{lineId:'4',variantId:'60',locationId:'70',quantity:2}]),JSON.stringify(bl)]);
 const stock={id:'40',label:'V3PS-d',status:'completed',update_stock:true,line_items:[{quantity:mismatch?3:2,variant:{id:'60'},location:{id:'70'}}]};
 const calls=[];
 const api={verify:async()=>{},request:async(q)=>{
  calls.push(q);assert.ok(q.startsWith('query'),'no Erplain mutation');
  if(q.includes('V3RecoverPartialStock')){
   if(concurrent)await e.query("UPDATE partial_deliveries SET error='concurrent edit' WHERE id='d'");
   return {StockRemovals:{data:native?[]:ambiguous?[stock,{...stock,id:"41"}]:[stock],paginatorInfo:{hasMorePages:incomplete}}};
  }
  if(q.includes('V3HistoricalStockLogs'))return {InventoryLogs:{data:missing?[]:[{id:'90',document_id:'10',order_type:'Order',on_hand_diff:-2,available_diff:-2,variant:{id:'60'},location:{id:'70'}}],paginatorInfo:{hasMorePages:false}}};
  throw Error('Unexpected read '+q);
 }};
 const db={query:(...args)=>e.query(...args),transaction:fn=>e.transaction(fn)};
 return {e,db,api,bc,calls};
}
for(const native of [false,true])test(`refresh recovers ${native?'verified Erplain ledger':'exact separate stock receipt'} and releases shared product lock`,async()=>{
 const f=await fixture({native});try{
  await assert.rejects(assertStockResolved(f.db,['60'],{orderId:'other'}),/PHARM828087/);
  const r=await refreshPartialFromErplain(f.db,f.api,'o',{document:f.bc});
  assert.deepEqual(r.stockHolds,[]);
  const d=(await f.e.query('SELECT * FROM partial_deliveries')).rows[0];
  if(native){assert.equal(d.stock_document.notRequired,true);assert.deepEqual(d.stock_document.proof.logIds,['90']);}else assert.equal(d.stock_document.id,'40');
  assert.equal(d.bl.status,'pending');assert.deepEqual(d.tracking,['tracking-kept']);
  await assertStockResolved(f.db,['60'],{orderId:'other'});
 }finally{await f.e.close();}
});
for(const mode of ['mismatch','incomplete','ambiguous'])test(`refresh preserves stock lock on ${mode}`,async()=>{
 const f=await fixture({[mode]:true});try{
  const r=await refreshPartialFromErplain(f.db,f.api,'o',{document:f.bc});assert.equal(r.stockHolds.length,1);
  assert.equal((await f.e.query('SELECT stock_document FROM partial_deliveries')).rows[0].stock_document,null);
  await assert.rejects(assertStockResolved(f.db,['60'],{orderId:'other'}),/rapprocher/);
 }finally{await f.e.close();}
});
test('concurrent change prevents stale recovery from being saved',async()=>{
 const f=await fixture({concurrent:true});try{
  await assert.rejects(refreshPartialFromErplain(f.db,f.api,'o',{document:f.bc}),/modifiée/);
  const d=(await f.e.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(d.stock_document,null);assert.equal(d.error,'concurrent edit');
 }finally{await f.e.close();}
});

test('native stock without a physical debit remains blocked',async()=>{
 const f=await fixture({native:true,missing:true});try{
  const r=await refreshPartialFromErplain(f.db,f.api,'o',{document:f.bc});assert.equal(r.stockHolds.length,1);
  assert.equal((await f.e.query('SELECT stock_document FROM partial_deliveries')).rows[0].stock_document,null);
  await assert.rejects(assertStockResolved(f.db,['60'],{orderId:'other'}),/rapprocher/);
 }finally{await f.e.close();}
});
