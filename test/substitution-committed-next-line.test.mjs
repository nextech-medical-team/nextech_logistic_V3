import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {findRecordedSubstitution} from '../src/substitution-recovery.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function fixture(){
 const line=(id,sku,variant,price,tax)=>({id,type:'normal',quantity:1,price,tax_amount:tax,tax_codes:[{id:'t'}],discount:0,discount_rule_amount:0,ecotax:0,location:{id:'w'},variant:{id:variant,sku,active:true,product:{active:true}}});
 const before={id:'10',status:'active',update_stock:false,total:30,tax_type:'exclusive',currency:{label:'EUR'},line_items:[line('a','A','1',10,2),line('b','B','2',15,3)],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
 const bc=structuredClone(before);bc.line_items[0]=line('x','X','3',10,2);
 const payload={id:'o',requestId:'first',sku:'A',replacementSku:'X',replaceQuantity:1,replacementQuantity:1,scope:'order',confirmEquivalent:true,previewFingerprint:'a'.repeat(64)};
 const plan={bcId:'10',originalSku:'A',replacementSku:'X',replaceQuantity:1,replacementQuantity:1,previewFingerprint:payload.previewFingerprint,commercialBefore:before,items:[{variant:{id:'3'},location:{id:'w'},quantity:1,price:10,tax_codes:[{id:'t'}]},{id:'b',quantity:1,price:15}],expected:[{sku:'X',quantity:1},{sku:'B',quantity:1}]};
 payload.substitutionAttempt={version:1,phase:'local_committed',orderId:'o',requestId:'first',fingerprint:payload.previewFingerprint,plan,planHash:createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex'),permanent:null,completionResult:{erpOnly:true}};
 const f={bc,failed:{id:'j',status:'review',error:'BL bloqué — stock insuffisant : B : 1 nécessaires, 0 utilisables, manque 1',payload},order:{id:'o',erp_live:{bc:{id:'10'},equivalentAttemptId:'first'}},next:{id:'o',requestId:'next',sku:'B',replacementSku:'Y',replaceQuantity:1,replacementQuantity:1,scope:'order'},rows:[{source_sku:'X',quantity:1},{source_sku:'B',quantity:1}],queries:[]};
 f.db={async query(sql){f.queries.push(sql);assert.ok(sql.startsWith('SELECT'),'reconciliation must not write');return {rows:sql.includes('SELECT * FROM lines')?f.rows:[f.failed]};}};
 return f;
}
test('an exact BC and committed V3 lines allow previewing another deficient line without replaying the first mutation',async()=>{
 const f=fixture();assert.equal(await findRecordedSubstitution(f.db,f.order,f.next,f.bc),null);assert.equal(f.queries.length,2);assert.equal(f.failed.status,'review');assert.equal(f.failed.payload.substitutionAttempt.phase,'local_committed');
});
test('the original request still uses the recorded read-only recovery',async()=>{
 const f=fixture();const r=await findRecordedSubstitution(f.db,f.order,f.failed.payload,f.bc);assert.equal(r.localCommitted,true);assert.equal(r.reconcileOnly,true);assert.equal(r.attemptRecovery,true);
});
for(const [name,change] of [
 ['uncertain mutation',f=>f.failed.payload.substitutionAttempt.phase='mutation_started'],
 ['uncertain provider failure',f=>f.failed.error='Résultat incertain'],
 ['permanent mapping',f=>f.next.scope='permanent'],
 ['chained replacement',f=>f.next.sku='X'],
 ['partial delivery',f=>f.order.partial_mode=true],
 ['wrong committed attempt',f=>f.order.erp_live.equivalentAttemptId='other'],
 ['local quantity divergence',f=>f.rows[1].quantity=2],
 ['BC quantity divergence',f=>f.bc.line_items[1].quantity=2],
 ['retained price changed',f=>f.bc.line_items[1].price=14],
 ['tax total changed',f=>f.bc.line_items[1].tax_amount=4],
 ['new delivery',f=>f.bc.shipping_orders.data.push({id:'bl'})],
 ['discounted line',f=>f.bc.line_items[1].discount=1],
 ['stock already removed',f=>f.bc.update_stock=true],
 ['incomplete BC',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true],
 ['invalid recorded proof',f=>f.failed.payload.substitutionAttempt.planHash='0'.repeat(64)]
])test('next line stays blocked: '+name,async()=>{const f=fixture();change(f);await assert.rejects(findRecordedSubstitution(f.db,f.order,f.next,f.bc));});

function rejectedFixture(){const f=fixture();f.bc=structuredClone(f.failed.payload.substitutionAttempt.plan.commercialBefore);f.failed.payload.substitutionAttempt.phase='mutation_started';f.failed.error='Le résultat de le remplacement du produit → du produit choisi reste à vérifier. ERPLAIN LIVE : écriture non autorisée ou identité non vérifiée La préparation reste suspendue. Relisez le BC et les BL avant toute reprise ; ne répétez pas l’enregistrement.';f.next={...f.failed.payload,requestId:'fresh'};return f;}
test('a proven local refusal before fetch and unchanged full BC permits a fresh preview',async()=>{const f=rejectedFixture();assert.equal(await findRecordedSubstitution(f.db,f.order,f.next,f.bc),null);assert.equal(f.queries.length,1);assert.equal(f.failed.payload.substitutionAttempt.phase,'mutation_started');});
for(const [name,change] of [
 ['network uncertainty',f=>f.failed.error='Résultat incertain : HTTP 504'],
 ['changed quantity',f=>f.bc.line_items[0].quantity=2],
 ['changed price',f=>f.bc.line_items[0].price=11],
 ['changed tax',f=>f.bc.line_items[0].tax_amount=3],
 ['changed total',f=>f.bc.total=31],
 ['changed currency',f=>f.bc.currency.label='USD'],
 ['different replacement',f=>f.next.replacementSku='Z'],
 ['other line',f=>f.next.sku='B'],
 ['new BL',f=>f.bc.shipping_orders.data.push({id:'bl'})],
 ['incomplete read',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true],
 ['permanent scope',f=>f.next.scope='permanent'],
 ['partial order',f=>f.order.partial_mode=true],
 ['invalid journal',f=>f.failed.payload.substitutionAttempt.planHash='bad']
])test('local refusal remains blocked: '+name,async()=>{const f=rejectedFixture();change(f);await assert.rejects(findRecordedSubstitution(f.db,f.order,f.next,f.bc));});
