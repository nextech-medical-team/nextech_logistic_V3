import test from 'node:test';
import assert from 'node:assert/strict';
import * as standard from '../src/partial-deliveries.mjs';
import * as tender from '../src/partial-deliveries-tender-preserved.mjs';
import {assertFullOrderStock} from '../src/stock-gate.mjs';
const raw=(change={})=>({id:'1',type:'normal',quantity:200,price:1,shipped_quantity:0,reserved_quantity:0,on_hand:94,available:94,incoming:35200,variant:{id:642510,sku:'TR03',track_inventory:true},location:{id:100934},...change});
for(const [name,service] of Object.entries({standard,tender})){
 for(const [scenario,change,quantity] of [
  ['94/200 real case',{},200],['negative', {on_hand:-106,available:-106},1],['zero',{on_hand:0,available:0},1],
  ['negative available',{on_hand:200,available:-1},1],['missing physical',{on_hand:null},1],['missing available',{available:null},1],
  ['blank physical',{on_hand:''},1],['boolean physical',{on_hand:true},1],['boolean available',{available:true},1],
  ['unknown reservation',{reserved_quantity:null},1],['boolean reservation',{reserved_quantity:true},1],
  ['unknown policy',{variant:{id:642510,sku:'TR03'}},1],['tiny shortage',{on_hand:.9999999,available:.9999999},1],
  ['boolean requested',{},true],['blank requested',{},''],['negative requested',{},-1],['hex requested',{},'0x1']
 ])test(`${name} partial rejects ${scenario}`,()=>{const lines=service.partialLines([raw(change)]);assert.throws(()=>service.validatePartial(lines,[{lineId:'1',quantity}]));});
 test(name+' exact fractional stock supports 0.1 + 0.2 without tolerance',()=>{
  const lines=service.partialLines([raw({quantity:1,on_hand:.3,available:.3}),raw({id:'2',quantity:1,on_hand:.3,available:.3})]);
  assert.equal(service.validatePartial(lines,[{lineId:'1',quantity:.1},{lineId:'2',quantity:.2}]).length,2);
  assert.throws(()=>service.validatePartial(lines,[{lineId:'1',quantity:.2},{lineId:'2',quantity:.2}]),/insuffisant/);
 });
 test(name+' pending other delivery cannot hide a decimal shortage',()=>{
  const rows=[raw({quantity:1,on_hand:.4,available:.4})];
  const deliveries=[{id:'hold',status:'queued',selection:[{lineId:'1',variantId:'642510',locationId:'100934',quantity:.1}]}];
  const lines=service.partialLines(rows,deliveries);
  assert.equal(service.validatePartial(lines,[{lineId:'1',quantity:.3}]).length,1);
  assert.throws(()=>service.validatePartial(lines,[{lineId:'1',quantity:'0.30000000000000003'}]),/insuffisant/);
 });
 test(name+' untracked product uses explicit product policy',()=>{
  const lines=service.partialLines([raw({on_hand:null,available:null,variant:{id:642510,sku:'TR03',track_inventory:false}})]);
  assert.equal(service.validatePartial(lines,[{lineId:'1',quantity:200}])[0].quantity,200);
 });
 test(name+' location stocks remain independent',()=>{
  const lines=service.partialLines([raw({quantity:1,on_hand:1,available:1}),raw({id:'2',location:{id:200000},quantity:1,on_hand:1,available:1})]);
  assert.equal(service.validatePartial(lines,[{lineId:'1',quantity:1},{lineId:'2',quantity:1}]).length,2);
 });
 test(name+' duplicate selection and over-order quantity refuse',()=>{
  const lines=service.partialLines([raw({quantity:1,on_hand:100,available:100})]);
  assert.throws(()=>service.validatePartial(lines,[{lineId:'1',quantity:1},{lineId:'1',quantity:1}]));
  assert.throws(()=>service.validatePartial(lines,[{lineId:'1',quantity:2}]));
 });
}
for(const preserveInstalled of [true,false]){
 test('full stock exactness also applies with legacy option '+preserveInstalled,()=>{
  assert.throws(()=>assertFullOrderStock([raw({quantity:1,on_hand:.9999999,available:.9999999})],{preserveInstalled}),/insuffisant/);
  assert.throws(()=>assertFullOrderStock([raw({quantity:1,on_hand:200,available:200,variant:{id:642510,sku:'TR03'}})],{preserveInstalled}),/non vérifiable/);
 });
}
