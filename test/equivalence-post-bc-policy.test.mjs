import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSubstitution} from '../src/stock-substitution.mjs';
import {recordedSubstitutionPlan} from '../src/substitution-recovery.mjs';
import {substitutionExecutionSnapshot,substitutionBcSnapshot} from '../src/substitution-execution-snapshot.mjs';
import {verifySubstitutionShipping} from '../src/substitution-shipping-check.mjs';

test('shared BC stock drift is ignored, but order identity and allocations remain protected',()=>{
 const {bc,b,v}=fixture();
 const before=structuredClone(bc);
 before.line_items[0].available=-200;before.line_items[0].on_hand=-200;
 const after=structuredClone(before);
 after.line_items[0].available=-100;after.line_items[0].on_hand=-100;
 assert.equal(buildSubstitution(before,v,b).previewFingerprint,buildSubstitution(after,v,b).previewFingerprint);
 assert.equal(before.line_items[0].on_hand,-200,'original evidence remains intact');
 for(const mutate of [
  x=>{x.line_items[0].reserved_quantity=1;},
  x=>{x.line_items[0].quantity=11;},
  x=>{x.line_items[0].variant.id='different';},
  x=>{x.line_items[0].location.id='different';},
  x=>{x.status='pending';},
  x=>{x.shipping_orders.data.push({id:'new-bl'});}
 ]){
  const changed=structuredClone(after);mutate(changed);
  assert.notDeepEqual(substitutionBcSnapshot(before),substitutionBcSnapshot(changed));
 }
 assert.notDeepEqual(substitutionExecutionSnapshot(before),substitutionExecutionSnapshot(after),'historical recovery snapshots keep their stock evidence');
});

function fixture(){
 const v=sku=>({id:sku,sku,active:true,product:{active:true},track_inventory:true,weight_amount:1,weight_unit:'g',stock_levels:{data:[{location:{id:'L'},available:50,on_hand:50}],paginatorInfo:{hasMorePages:false}}});
 const bc={id:'11',status:'active',update_stock:false,tax_type:'exclusive',total:17.48,currency:{label:'EUR'},shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},line_items:[{id:'a',type:'normal',quantity:10,price:1,tax_amount:2,tax_codes:[{id:'tax'}],variant:v('A'),location:{id:'L'}}]};
 const b={scope:'order',sku:'A',replacementSku:'B',replaceQuantity:10,replacementQuantity:20};
 return {bc,b,v:v('B')};
}

for(const [name,patch] of [['missing policy',{track_inventory:undefined}],['boolean stock',{stock_levels:{data:[{location:{id:'L'},on_hand:true,available:true}],paginatorInfo:{hasMorePages:false}}}],['blank stock',{stock_levels:{data:[{location:{id:'L'},on_hand:'',available:''}],paginatorInfo:{hasMorePages:false}}}],['unknown pagination',{stock_levels:{data:[{location:{id:'L'},on_hand:50,available:50}],paginatorInfo:{}}}]])test('replacement refuses '+name,()=>{
 const f=fixture();f.b.replacementQuantity=1;Object.assign(f.v,patch);assert.throws(()=>buildSubstitution(f.bc,f.v,f.b));
});
test('replacement compares cumulative fractional quantities exactly',()=>{
 const f=fixture();f.b.replacementQuantity=.1;
 f.bc.line_items.push({...f.bc.line_items[0],id:'b',quantity:.2,variant:f.v});
 f.v.stock_levels.data[0].on_hand=.3;f.v.stock_levels.data[0].available=.3;
 assert.equal(buildSubstitution(f.bc,f.v,f.b).replacementQuantity,.1);
 f.v.stock_levels.data[0].on_hand=.2999999;
 assert.throws(()=>buildSubstitution(f.bc,f.v,f.b),/stock insuffisant/);
});
test('replacement quantities cannot be boolean',()=>{const f=fixture();f.b.replacementQuantity=true;assert.throws(()=>buildSubstitution(f.bc,f.v,f.b),/positives/);});
test('amounts, taxes, discounts and currency cannot invalidate an equivalence preview',()=>{
 const {bc,b,v}=fixture(),plan=buildSubstitution(bc,v,b);
 for(const patch of [{total:999,currency:{label:'USD'}},{total:null,tax_type:null}]){
  const changed=structuredClone(bc);Object.assign(changed,patch);Object.assign(changed.line_items[0],{price:null,tax_amount:null,discount:20,ecotax:1});
  const next=buildSubstitution(changed,v,b);
  assert.equal(next.previewFingerprint,plan.previewFingerprint);
  assert.equal(next.items.at(-1).price,undefined);
  assert.deepEqual(next.expected,[{sku:'B',quantity:20}]);
 }
 const noTax=structuredClone(bc);delete noTax.line_items[0].tax_codes;assert.doesNotThrow(()=>buildSubstitution(noTax,v,b));
 assert.throws(()=>buildSubstitution({...bc,id:null},v,b),/non modifiable/);
 assert.throws(()=>buildSubstitution(bc,{...v,stock_levels:{...v.stock_levels,data:[{location:{id:'L'},available:19,on_hand:19}]}},b),/stock insuffisant/);
});
test('sent replacement is confirmed by document, products and quantities without monetary gates',()=>{
 const {bc,b,v}=fixture(),plan=buildSubstitution(bc,v,b);plan.previewFingerprint='f';
 const request={...b,confirmEquivalent:true,previewFingerprint:'f'};
 const current={...bc,total:999,tax_type:'inclusive',currency:{label:'USD'},line_items:[{id:'new',type:'normal',quantity:20,variant:v,location:{id:'L'},price:123,tax_amount:456}]};
 const recover=after=>recordedSubstitutionPlan(after,b,{id:'j',status:'review',payload:request,error:'Frais de livraison modifiés : rapprochement requis'},{status:'complete',payload:request,result:plan});
 assert.equal(recover(current).reconcileOnly,true);
 const noMoney=structuredClone(current);delete noMoney.total;delete noMoney.currency;delete noMoney.line_items[0].price;delete noMoney.line_items[0].tax_amount;
 assert.equal(recover(noMoney).reconcileOnly,true);
 assert.throws(()=>recover({...current,line_items:[{...current.line_items[0],quantity:19}]}),/rapproché/);
 assert.throws(()=>recover({...current,id:'12'}),/rapproché/);
 assert.throws(()=>recover({...current,line_items:[{...current.line_items[0],location:{id:'OTHER'}}]}),/rapproché/);
});
test('shipping amount changes are observations while shipment identities remain protected',()=>{
 const before={line_items:[{id:'s',type:'shipping_cost',quantity:1,price:1,tax_amount:.2}]};
 assert.equal(verifySubstitutionShipping(before,{line_items:[{...before.line_items[0],price:999,tax_amount:null}]}).commercialComparisonPerformed,false);
 assert.throws(()=>verifySubstitutionShipping(before,{line_items:[]}),/livraison modifiées/);
 assert.throws(()=>verifySubstitutionShipping(before,{line_items:[{...before.line_items[0],quantity:2}]}),/livraison modifiées/);
 assert.notDeepEqual(substitutionExecutionSnapshot({id:'1',quantity:1}),substitutionExecutionSnapshot({id:'1',quantity:2}));
});
