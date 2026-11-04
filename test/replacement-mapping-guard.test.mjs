import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {substitution,buildSubstitution} from '../src/stock-substitution.mjs';

test('missing replacement mapping blocks preview and application before provider calls or local writes',async()=>{
 const pg=new PGlite();await pg.waitReady;
 try{
  await pg.exec('CREATE TABLE mappings(channel text,source_sku text,target_sku text)');
  await pg.query("INSERT INTO mappings VALUES ('amazon','source','B'),('shopify','B','OTHER')");
  const db={query:(s,p)=>pg.query(s,p),transaction:()=>assert.fail('no local mutation')};
  const api={verify:()=>assert.fail('no provider call'),request:()=>assert.fail('no provider call')};
  const o={id:'o',channel:'shopify',erp_live:{bc:{id:'11'}}};
  const before=structuredClone(o);
  for(const scope of ['order','permanent'])for(const apply of [false,true]){
   await assert.rejects(substitution(db,api,o,{sku:'A',replacementSku:' B ',replaceQuantity:1,replacementQuantity:1,scope,confirmEquivalent:true,verifyAndApply:true},{apply}),/absent du mapping.*shopify.*BC non modifié/);
  }
  assert.deepEqual(o,before);
  assert.equal((await pg.query('SELECT * FROM mappings')).rows.length,2);
  await pg.query("INSERT INTO mappings VALUES ('shopify','source','B')");
  // Passing the guard reaches the next operational read, without modifying BC.
  const sentinel=new Error('next preparation check');
  const guardedDb={query:async(s,p)=>s.includes('FROM mappings')?pg.query(s,p):Promise.reject(sentinel)};
  await assert.rejects(substitution(guardedDb,api,o,{sku:'A',replacementSku:'B',replaceQuantity:1,replacementQuantity:1,scope:'order'}),e=>e===sentinel);
 }finally{await pg.close();}
});

test('replacement unit price comes from recorded BC even when marketplace price differs',()=>{
 const original={id:'1',type:'normal',quantity:4,price:17,tax_amount:0,tax_codes:[],location:{id:'1'},variant:{id:'1',sku:'A',weight_amount:1,weight_unit:'kg'}};
 const bc={id:'11',status:'active',update_stock:false,tax_type:'exclusive',total:68,line_items:[original],shipping_orders:{data:[]}};
 const variant={id:'2',sku:'B',active:true,product:{active:true},track_inventory:false,weight_amount:1,weight_unit:'kg',price:99};
 const plan=buildSubstitution(bc,variant,{sku:'A',replacementSku:'B',replaceQuantity:4,replacementQuantity:8,scope:'order',marketplacePrice:200});
 assert.equal(plan.items[0].price,8.5);
 assert.equal(plan.items[0].price*plan.items[0].quantity,68);
 assert.equal(bc.total,68);assert.equal(original.price,17);
});

test('direct Erplain, tender and sample documents do not require a marketplace mapping',async()=>{
 const sentinel=new Error('next preparation check');
 const db={query:async sql=>{assert.ok(!sql.includes('FROM mappings'));throw sentinel;}};
 for(const channel of ['erplain','tender','samples','shopify']){
  const o={id:'o',channel,erp_live:{bc:{id:'11'}},source_payload:channel==='shopify'?{erplainImported:true}:{}};
  await assert.rejects(substitution(db,{},o,{sku:'A',replacementSku:'B',replaceQuantity:1,replacementQuantity:1,scope:'order'}),e=>e===sentinel);
 }
});
