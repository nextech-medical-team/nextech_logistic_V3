import test from 'node:test';
import assert from 'node:assert/strict';
import {readBeforeBlStock} from '../src/before-bl-stock.mjs';
const line={id:'1',type:'normal',quantity:10,available:5,on_hand:5,reserved_quantity:0,location:{id:'100'},variant:{id:'641220',sku:'413770',track_inventory:true}};
const api=(lines=[line])=>({request:async(q,v)=>{assert.match(q,/^query /);assert.equal(v.id,'10');return {Order:{id:'10',line_items:lines}};}});
test('413770 5/10 blocks before creation irrespective of historical BC debit',async()=>{
 await assert.rejects(readBeforeBlStock(api(),'10'),/10 nécessaires, 5 utilisables/);
});
test('full stock creates an auditable availability snapshot',async()=>{
 const proof=await readBeforeBlStock(api([{...line,available:10,on_hand:10}]),'10');
 assert.equal(proof.policy,'current_usable_before_bl');assert.equal(proof.lines[0].quantity,10);assert.equal(proof.lines[0].available,10);
});
test('reserved for this BC counts but physical stock remains the cap',async()=>{
 await readBeforeBlStock(api([{...line,available:0,on_hand:10,reserved_quantity:10}]),'10');
 await assert.rejects(readBeforeBlStock(api([{...line,available:0,reserved_quantity:10}]),'10'),/stock insuffisant/);
});
test('partial delivery checks exactly selected quantities',async()=>{
 await readBeforeBlStock(api(),'10',{selection:[{lineId:'1',quantity:5}]});
 await assert.rejects(readBeforeBlStock(api(),'10',{selection:[{lineId:'1',quantity:6}]}),/stock insuffisant/);
});
test('same product across lines cannot spend the same stock twice',async()=>{
 await assert.rejects(readBeforeBlStock(api([{...line,quantity:3},{...line,id:'2',quantity:3}]),'10'),/6 nécessaires, 5 utilisables/);
});
test('unknown stock and ambiguous selection fail closed',async()=>{
 await assert.rejects(readBeforeBlStock(api([{...line,available:null}]),'10'),/non vérifiable/);
 await assert.rejects(readBeforeBlStock(api(),'10',{selection:[{lineId:'1',quantity:1},{lineId:'1',quantity:1}]}),/ambiguë/);
 await assert.rejects(readBeforeBlStock(api([]),'10'),/absentes/);
});
