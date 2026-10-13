import test from 'node:test';import assert from 'node:assert/strict';import {readPreservedHistoricalBc} from '../src/historical-bc-pricing.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
const source={total:12.8,tax:2.13,currency:'EUR'};
function fixture(){const item={type:'normal',quantity:30,price:0.2725,tax_amount:1.64,discount:null,discount_rule_amount:null,ecotax:null,tax_codes:[{id:5}],variant:{id:20,sku:'X'},location:{id:1}};const freight={...item,type:'shipping_cost',variant:null,quantity:1,price:2.4917,tax_amount:0.49};const bc={id:10,label:'C-HIST',status:'active',external_reference:'PO-HIST',update_stock:true,tax_type:'exclusive',total:12.8,currency:{label:'EUR'},line_items:[item,freight]};const o={channel:'temu',reference:'PO-HIST',erp_live:{phase:'historical_review',bc:{id:10}},pricing:{tax_type:'exclusive',items:structuredClone([{...item,price:0.2814},{...freight,price:2.2247}])}};return {bc,o};}
test('preserves existing line allocation when current seller total, taxes, products and quantities agree',async()=>{const {bc,o}=fixture(),before=JSON.stringify(bc),calls=[];const r=await readPreservedHistoricalBc({request:async(q,v)=>{calls.push(q);assert.equal(v.id,'10');return {Order:bc};}},o,source);assert.equal(r.preserved,true);assert.equal(r.confirmed.authority,'recorded_erplain_bc');assert.equal(JSON.stringify(bc),before);assert.equal(calls.length,1);assert.ok(calls.every(q=>q.startsWith('query ')));});
test('never applies the historical preservation rule to newly created or other-channel BCs',async()=>{for(const patch of [{channel:'shopify'},{erp_live:{phase:'bc_created',bc:{id:10}}},{erp_live:{phase:'creating_bc',bc:{id:10}}},{erp_live:{phase:'historical_review'}}]){const {o}=fixture();assert.equal(await readPreservedHistoricalBc({request:()=>assert.fail('no supplier call')},{...o,...patch},source),null);}});

test('historical BC preserves real identity, document state and stock policy guards',async()=>{
 for(const patch of [b=>b.id=11,b=>b.status='closed',b=>b.external_reference='OTHER',b=>b.update_stock=null]){
  const {bc,o}=fixture();patch(bc);await assert.rejects(readPreservedHistoricalBc({request:async()=>({Order:bc})},o,source));
 }
});
test('historical BC accepts recorded content even when the old commercial copy differs',async()=>{
 for(const patch of [b=>b.total=30,b=>b.currency.label='USD',b=>b.line_items[0].quantity=31,b=>b.line_items[0].variant.id=21,b=>b.line_items[0].tax_codes=[{id:6}],b=>b.tax_type='inclusive',b=>b.line_items[0].tax_amount=8]){
  const {bc,o}=fixture();patch(bc);const before=structuredClone(bc);
  const r=await readPreservedHistoricalBc({request:async query=>{assert.match(query,/^query /);return {Order:bc};}},o,source);
  assert.equal(r.preserved,true);assert.equal(r.confirmed.authority,'recorded_erplain_bc');assert.deepEqual(bc,before);
 }
});
test('historical BC accepts missing fiscal fields as unverified observations',async()=>{
 const {bc,o}=fixture();delete bc.line_items[0].tax_amount;
 const result=await readPreservedHistoricalBc({request:async()=>({Order:bc})},o,source);assert.equal(result.preserved,true);assert.equal(result.confirmed.tax,null);
});
test('historical line-price review offers guarded resume while retaining its actual reason',()=>{const classify=currentProblemClassifier(),issue='BC · Prix, remises ou écotaxes des lignes Erplain différents de la source';const historical=classify({...fixture().o,issue});assert.equal(historical[0].type,'historical-preparation');assert.equal(historical[0].detail,issue);for(const phase of ['bc_created','creating_bc','bl_ready'])assert.notEqual(classify({...fixture().o,erp_live:{phase,bc:{id:10}},issue})[0].type,'historical-preparation');assert.notEqual(classify({...fixture().o,erp_live:{phase:'historical_review',bc:{id:10},bl:{id:20}},issue})[0].type,'historical-preparation');});
