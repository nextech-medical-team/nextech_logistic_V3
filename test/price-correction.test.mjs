import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionInput,priceCorrection} from '../src/price-correction.mjs';

const money=amount=>({amount,currency:'EUR'});
const document=()=>({id:'bc',external_reference:'#1',status:'active',total:120,currency:{label:'EUR'},paid_amount:0,invoices_count:0,tax_type:'exclusive',shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},line_items:[{id:'line',quantity:2,price:50,discount:0,discount_rule_amount:null,ecotax:0,tax_codes:[{id:'vat'}]}]});
test('scales existing unit prices while retaining line IDs and VAT codes',()=>{
 assert.deepEqual(correctionInput(document(),money(60)),{line_items:[{id:'line',price:25,tax_codes:[{id:'vat'}],apply_discount_rules:false}]});
});
test('rejects closed, invoiced, paid, shipped, discounted and incompatible documents',()=>{
 for(const patch of [{status:'closed'},{invoices_count:1},{paid_amount:1},{shipping_orders:{data:[{id:'bl'}],paginatorInfo:{hasMorePages:false}}},{currency:{label:'USD'}},{total:0}])assert.throws(()=>correctionInput({...document(),...patch},money(60)));
 const bc=document();bc.line_items[0].discount=5;assert.throws(()=>correctionInput(bc,money(60)));
});
function setup({changed=false,lost=false,mismatch=false,uncertain=false}={}){
 const order={id:'o',reference:'#1',channel:'shopify',address:{country:'FR'},erp_live:{bc:{id:'bc'},...(uncertain?{priceCorrection:{status:'uncertain'}}:{})}};
 const writes=[];let mutations=0;
 const db={async query(sql,args){writes.push({sql,args});return {rows:sql.startsWith('SELECT * FROM orders')?[order]:[]};}};
 const api={async verify(){},async request(query){if(query.startsWith('mutation')){mutations++;if(lost)throw Error('timeout');return {UpdateOrder:{id:'bc'}};}return {Order:{...document(),total:mutations&&!mismatch?60:120}};}};
 const verification={async check(){return {id:'o',bcId:'bc',status:'different',bc:money(120),source:money(changed?70:60)};}};
 return {correct:priceCorrection(db,null,verification,{api}),writes,mutations:()=>mutations};
}
const input={id:'o',bcId:'bc',bc:money(120),source:money(60)},user={email:'manager@example.test'};
test('reads back Erplain and saves confirmed total, including a lost mutation response',async()=>{
 for(const lost of [false,true]){const s=setup({lost});assert.equal((await s.correct(input,user)).status,'same');assert.equal(s.mutations(),1);assert.ok(s.writes.some(w=>w.args?.some(a=>typeof a==='string'&&a.includes('"status":"verified"'))));}
});
test('rejects stale platform totals and uncertain previous attempts without mutations',async()=>{
 for(const options of [{changed:true},{uncertain:true}]){const s=setup(options);await assert.rejects(s.correct(input,user));assert.equal(s.mutations(),0);}
});
test('unconfirmed correction retains uncertain marker and never records success',async()=>{
 const s=setup({mismatch:true});await assert.rejects(s.correct(input,user),/non confirmée/);assert.equal(s.mutations(),1);assert.ok(s.writes.some(w=>w.args?.some(a=>typeof a==='string'&&a.includes('"status":"uncertain"'))));assert.ok(!s.writes.some(w=>w.args?.some(a=>typeof a==='string'&&a.includes('"status":"verified"'))));
});
