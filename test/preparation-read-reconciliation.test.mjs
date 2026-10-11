import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {reconcilePreparationFromReads} from '../src/preparation-read-reconciliation.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';

async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,source_payload jsonb DEFAULT '{}',erp_live jsonb,suspension jsonb DEFAULT '{}',address jsonb DEFAULT '{}',weight_kg numeric,issue text,resolution_pending_resume boolean DEFAULT true,label_status text DEFAULT 'simulated',simulation boolean DEFAULT true);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,target_quantity numeric,quantity numeric,source_payload jsonb DEFAULT '{}');
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);CREATE TABLE partial_deliveries(order_id text,status text);CREATE TABLE carrier_jobs(order_id text,status text);
 CREATE TABLE resolution_jobs(id text,order_id text,action text,status text,error text,result jsonb,created_at timestamptz DEFAULT now());CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE audit(user_email text,action text,detail jsonb);
 INSERT INTO orders(id,reference,channel,erp_live) VALUES('o','REF','shopify','{"bc":{"id":"1"},"bl":{"id":"2"},"pricing":{"total":12,"tax":2,"currency":"EUR"}}');
 INSERT INTO lines(id,order_id,source_line,source_sku,target_sku,target_quantity,quantity) VALUES('l','o','1','X','X',2,2);
 INSERT INTO erp_live_jobs VALUES('o','complete',null);`);
 await db.query('UPDATE orders SET address=$1::jsonb',[JSON.stringify({name:'Destinataire test',street:'1 rue test',postal:'75001',city:'Paris',country:'FR'})]);
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{pricing}',$1::jsonb)",[JSON.stringify({total:12,tax:2,currency:'EUR',tax_type:'exclusive',items:[{type:'normal',quantity:2,variant:{id:'10'},tax_codes:[{id:'18'}]}]})]);
 const o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];await db.query("UPDATE orders SET erp_live=erp_live||$1::jsonb",[JSON.stringify({labelPreparationFingerprint:await shipmentFingerprint(db,o)})]);
 const line={type:'normal',quantity:2,variant:{id:'10',sku:'X'},location:{id:'20'},tax_amount:2,tax_codes:[{id:'18'}]};
 const shipping_address={label:'Destinataire test',address_1:'1 rue test',postal_code:'75001',city:'Paris',country:'France'};
 const bl={id:'2',label:'BL2',status:'ready_to_ship',update_stock:false,line_items:[line],shipping_address:{...shipping_address}};
 const bc={id:'1',external_reference:'REF',status:'active',update_stock:true,tax_type:'exclusive',total:12,currency:{label:'EUR'},line_items:[line],shipping_address:{...shipping_address},shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}};
 const options={readDocuments:async()=>bc,readCommercial:async()=>bc,proveHistorical:async()=>({stockOnBc:true,bcId:'1',quantities:[],logIds:['100']}),labelProof:async()=>true};
 const api={request:()=>assert.fail('unexpected external operation')};return {db,bc,bl,line,api,options};
}
test('fresh BC/BL/stock proof closes only local stale markers and is idempotent',async()=>{
 const {db,api,options}=await fixture();try{
  const r=await reconcilePreparationFromReads(db,api,'o',options);assert.equal(r.updated,true);assert.equal(r.providerMutations,0);
  const o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];assert.equal(o.resolution_pending_resume,false);assert.equal(o.simulation,false);assert.equal(o.label_status,'production_ready');assert.match(o.erp_live.mappingPreparationFingerprint,/^[a-f0-9]{64}$/);assert.equal(o.erp_live.bl.id,'2');assert.equal(o.erp_live.periodicReconciliation.labelsPreserved,true);
  assert.equal((await reconcilePreparationFromReads(db,api,'o',options)).updated,false);assert.equal((await db.query('SELECT count(*)::int n FROM audit')).rows[0].n,1);
 }finally{await db.close();}
});
for(const kind of ['quantity','currency','address','tax-code','active-correction','label-provenance','source-change','suspension','preview','missing-label','concurrent-change','provider-write'])test('reconciliation preserves the hold for '+kind,async()=>{
 const f=await fixture(),{db,api,options}=f;try{
  if(kind==='quantity')f.bl.line_items=[{...f.line,quantity:1}];
  if(kind==='currency')f.bc.currency.label='USD';
  if(kind==='address')f.bl.shipping_address.postal_code='69001';
  if(kind==='tax-code')f.line.tax_codes=[{id:'other'}];
  if(kind==='active-correction')await db.query("INSERT INTO correction_jobs VALUES('o','applying')");
  if(kind==='label-provenance')await db.query("UPDATE orders SET erp_live=erp_live-'labelPreparationFingerprint'");
  if(kind==='source-change')await db.query(`UPDATE orders SET source_payload='{"marketplacePendingCorrection":true}'`);
  if(kind==='suspension')await db.query(`UPDATE orders SET suspension='{"active":true}'`);
  if(kind==='preview')await db.query(`INSERT INTO resolution_jobs(id,order_id,action,status,result) VALUES('p','o','equivalent-preview','complete','{"replacementSku":"Y"}')`);
  if(kind==='missing-label')options.labelProof=async()=>false;
  if(kind==='concurrent-change')options.proveHistorical=async()=>{await db.query("UPDATE orders SET weight_kg=99");return {};};
  if(kind==='provider-write')options.proveHistorical=async provider=>provider.request('mutation Forbidden{CreateOrder{id}}');
  let r;try{r=await reconcilePreparationFromReads(db,api,'o',options);}catch(e){assert.match(e.message,/différent|incompatible|absente|interdite|en cours/);}
  assert.notEqual(r?.updated,true);assert.equal((await db.query('SELECT resolution_pending_resume held FROM orders')).rows[0].held,true);assert.equal((await db.query('SELECT count(*)::int n FROM audit')).rows[0].n,0);
 }finally{await db.close();}
});
