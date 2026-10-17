import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {partialService,initializePartialDeliveries} from '../src/partial-deliveries.mjs';
import {reconcileFullStock} from '../src/stock-cycle.mjs';
import {withShipmentLock} from '../src/shipment-lock.mjs';
import {assertNewBcStock} from '../src/new-bc-stock-gate.mjs';
const channels=['amazon','shopify','relay','temu','samples','rakuten','tender'];
const conn=data=>({data,paginatorInfo:{hasMorePages:false}});
const line=(quantity=200,stock=94)=>({id:'20',type:'normal',quantity,price:1,tax_amount:0,reserved_quantity:0,shipped_quantity:0,on_hand:stock,available:stock,location:{id:'70'},variant:{id:'60',sku:'TR03',track_inventory:true}});

test('actual partial worker refuses shortage on every channel, stock policy and import mode with zero provider mutations',async t=>{
 const e=new PGlite(),db={query:(...a)=>e.query(...a),exec:(...a)=>e.exec(...a),transaction:fn=>e.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))};
 try{
  await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,carrier text,address jsonb,source_payload jsonb,erp_live jsonb,suspension jsonb,tracking_status text,erp_status text,label_status text,issue text,parcel_count int,transport_choice text,archived boolean DEFAULT false);CREATE TABLE erp_live_jobs(order_id text,status text,updated_at timestamptz,error text);CREATE TABLE carrier_jobs(order_id text,status text,tracking jsonb,result jsonb,carrier text,reference text);CREATE TABLE carrier_documents(order_id text,document_index int,pdf bytea);`);
  await initializePartialDeliveries(db);
  let bc;const mutations=[];
  const api={verify:async()=>({id:100174}),request:async(q,v)=>{if(q.startsWith('mutation'))mutations.push({q,v});throw Error('Unexpected provider call: '+q);}};
  const worker=partialService(db,'unused',{api,clients:{},refreshDocuments:async()=>({bc})});
  for(const channel of channels)for(const updateStock of [false,true])for(const imported of [false,true])for(const checkpoint of channel==='tender'?['queued']:['queued','draft_confirmed','lines_confirmed'])await t.test(`${channel} stock=${updateStock} imported=${imported} checkpoint=${checkpoint}`,async()=>{
   await e.exec('DELETE FROM partial_deliveries; DELETE FROM orders;');mutations.length=0;
   bc={id:'10',label:'C0016130',status:'active',update_stock:updateStock,total:200,currency:{label:'EUR'},customer:{id:'50'},line_items:[line()],shipping_orders:conn([])};
   const source=imported?{erplainImported:true,account:'live',erplainValidation:'approved'}:{};
   await e.query("INSERT INTO orders(id,reference,channel,carrier,address,source_payload,erp_live,suspension,tracking_status,label_status) VALUES('o','CASE',$1,'gls','{}',$2,$3,'{}','unknown','pending')",[channel,JSON.stringify(source),JSON.stringify({bc:{id:'10',status:'active'}})]);
   const selection=[{lineId:'20',variantId:'60',locationId:'70',sku:'TR03',quantity:200,price:1}];
   const draft=checkpoint==='queued'?null:{id:'30',status:'unpublished',update_stock:updateStock};
   await e.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,selection,label_choice,environment,bl,stage) VALUES('d','o','r',$3,$1,$2,'production',$4,$3)",[JSON.stringify(selection),channel==='temu'?'bl_only_temu':'new',checkpoint,draft?JSON.stringify(draft):null]);
   await worker.run();
   const delivery=(await e.query("SELECT status,error FROM partial_deliveries WHERE id='d'")).rows[0];
   assert.equal(delivery.status,'review',delivery.error);
   assert.match(delivery.error,channel==='relay'?/partielle non disponible/:/stock insuffisant/);
   assert.equal(mutations.length,0,'No draft creation, BL publication or stock removal');
  });
 }finally{await e.close();}
});

for(const channel of channels)test(channel+' legacy full stock-removal path refuses shortage without provider mutation',async()=>{
 const item=line(),bc={id:10,status:'active',update_stock:false,line_items:[item],shipping_orders:conn([{id:30}])},bl={id:30,label:'SHO00745275',status:'pending',update_stock:false,line_items:[item]};
 const o={id:'case',channel,items:[item],erp_live:{bc:{id:10},bl:{id:30}}},mutations=[];
 const api={request:async q=>{if(q.startsWith('mutation'))mutations.push(q);if(q.includes('FindCycleStock'))return {StockRemovals:conn([])};if(q.includes('CheckCycleStock'))return {Order:bc,ShippingOrder:bl};throw Error('Unexpected call '+q);}};
 await assert.rejects(()=>reconcileFullStock(api,o,{allowCreate:true}),/stock insuffisant/);
 assert.equal(mutations.length,0);
});

test('shared lock re-reads stock for concurrent BC admissions: only one covered debit',async()=>{
 let stock=300,writes=0;const item={...line(),location:{id:'70'},variant:{id:'60',sku:'TR03'}};
 const api={request:async q=>{assert.match(q,/^query /);return {Variants:conn([{id:'60',sku:'TR03',track_inventory:true,stock_levels:conn([{location:{id:'70'},on_hand:stock,available:stock}])}])};}};
 const attempt=()=>withShipmentLock(async()=>{await assertNewBcStock(api,[item]);await new Promise(r=>setTimeout(r,5));stock-=200;writes++;});
 const results=await Promise.allSettled([attempt(),attempt()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(stock,100);assert.equal(writes,1);
});
