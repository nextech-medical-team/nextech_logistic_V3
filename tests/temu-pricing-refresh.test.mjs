import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshTemuOrderPricing,ensureTemuBcPricing} from '../src/temu-bc-pricing.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {validateResolution} from '../src/problem-resolution.mjs';
import {readFile} from 'node:fs/promises';

const money=amount=>({amount,currency:'EUR'});
function fixture(){
 const data={parentOrderMap:{parentOrderSn:'PO-test',estimatedRevenue:money(5000),basePriceTotal:money(4000),shippingAmountTotal:money(0),taxTotal:money(1000)},orderList:[{orderSn:'line-1',quantity:2,basePrice:money(4000),unitBasePrice:money(2000),productTaxAmount:money(1000),productTaxRate:25000000,shipAmountTotalTaxIncl:money(0),shipTaxAmount:money(0),shipTaxRate:25000000}]};
 const order={id:'order-1',reference:'PO-test',channel:'temu',address:{country:'HR'},source_payload:{mallId:'mall-1'}};
 const lines=[{source_line:'line-1',source_sku:'SKU',quantity:2}];
 const db={async query(sql,args){
  if(sql.startsWith('UPDATE orders SET source_payload')){Object.assign(order.source_payload,JSON.parse(args[1]));return {rows:[]};}
  if(sql.startsWith('SELECT source_payload'))return {rows:[{source_payload:order.source_payload}]};
  if(sql.startsWith('SELECT * FROM orders'))return {rows:[order]};
  if(sql.startsWith('SELECT * FROM lines'))return {rows:lines};
  throw Error('Unexpected query: '+sql);
 }};
 return {data,order,lines,db};
}
test('refresh uses newly read official amounts, not manual prices',async()=>{
 const f=fixture();f.order.source_payload.temuManualPricing={data:{},vatRate:25};
 let called=0;
 const result=await refreshTemuOrderPricing(f.db,f.order,async ref=>{assert.equal(ref,'PO-test');called++;f.order.source_payload.temuAmounts={data:f.data,at:'2026-10-10T10:00:00Z'};});
 assert.equal(called,1);assert.equal(result.readOnly,true);
 assert.equal(result.pricing.orderList[0].unitBasePrice.amount,2000);
 assert.equal(result.pricing.parentOrderMap.estimatedRevenue.amount,5000);
 assert.equal(result.amountsReadAt,'2026-10-10T10:00:00Z');
});
test('access refusal is not replaced with cached prices',async()=>{
 const f=fixture();f.order.source_payload.temuAmounts={data:f.data};
 await assert.rejects(refreshTemuOrderPricing(f.db,f.order,async()=>({error:'Accès refusé (3000032)'})),/3000032/);
});
test('inconsistent quantities prevent successful refresh',async()=>{
 const f=fixture();f.lines[0].quantity=1;
 await assert.rejects(refreshTemuOrderPricing(f.db,f.order,async()=>{f.order.source_payload.temuAmounts={data:f.data};}),/Quantité TEMU différente/);
});
test('manual amounts cannot replace absent official seller revenue',async()=>{
 const f=fixture();delete f.data.parentOrderMap.estimatedRevenue;
 await assert.rejects(refreshTemuOrderPricing(f.db,f.order,async()=>{f.order.source_payload.temuAmounts={data:f.data};}),/estimatedRevenue/);
});
test('BC failure preserves reauthorization advice and omits fixed VAT claim',async()=>{
 const f=fixture();
 await assert.rejects(ensureTemuBcPricing(f.db,f.order,f.lines,async()=>{throw Error('Boutique à réautoriser dans Seller Center (3000032)');}),e=>e.message.includes('Seller Center')&&!e.message.includes('25 % automatique'));
});
test('force refresh reloads shop authorization and bypasses cached amounts',async()=>{
 const f=fixture();let token='old',calls=[];
 const service=temuLocalService(f.db,'.',{configLoader:async()=>({TEMU_ACCESS_TOKEN:token}),shopLoader:async()=>[],apiFactory:config=>({async read(type){
  if(type==='bg.open.accesstoken.info.get')return {mallId:'mall-1'};
  assert.equal(type,'bg.order.amount.query');calls.push(config.TEMU_ACCESS_TOKEN);
  if(config.TEMU_ACCESS_TOKEN==='old')throw Error('3000032');
  return f.data;
 }})});
 assert.match((await service.amounts(f.order.reference,{force:true})).error,/3000032/);
 token='renewed';assert.equal((await service.amounts(f.order.reference,{force:true})).updated,true);
 assert.equal(f.order.source_payload.temuAmountsError,null);
 token='newest';await service.amounts(f.order.reference,{force:true});
 assert.deepEqual(calls,['old','renewed','newest']);
});
test('pricing refresh only accepts TEMU provider',()=>{
 const input={id:'order-1',requestId:'12345678-1234-1234-1234-123456789012',action:'refresh',type:'temu-pricing',provider:'TEMU',resumeAfter:false};
 assert.equal(validateResolution(input),input);
 assert.throws(()=>validateResolution({...input,provider:'Erplain'}),/depuis TEMU/);
});
test('dialog renders official prices and disables resume after a failed reread',async()=>{
 const source=await readFile(new URL('../public/problem-corrections.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf(" if(spec.view==='temu-pricing'){"),source.indexOf(" if(spec.view==='platform'){"));
 const element=()=>({children:[],textContent:'',append(x){this.children.push(x);},before(){},setAttribute(){},replaceChildren(){this.children=[];}});
 const f=fixture();let fails=false;const buttons=[],fields=element();
 const ctx={lines:f.lines};const d={closed:false};
 const run=new Function('spec','scope','problem','document','fields','button','task','d','ctx','saved',block);
 run({view:'temu-pricing'},element(),{detail:'3000032'},{createElement:element},fields,(label,fn)=>{const b={label,click:fn};buttons.push(b);return b;},async(action,input)=>{
  assert.equal(action,'refresh');assert.equal(input.provider,'TEMU');assert.equal(input.resumeAfter,false);
  if(fails)throw Error('3000032');
  return {pricing:f.data,amountsReadAt:'2026-10-10T10:00:00Z'};
 },d,ctx,()=>{});
 assert.equal(buttons[1].disabled,true);
 await buttons[0].click();assert.equal(buttons[1].disabled,false);
 assert.match(fields.children[0].children[0].textContent,/SKU.*Quantité TEMU : 2.*20,00/);
 fails=true;await assert.rejects(buttons[0].click(),/3000032/);
 assert.equal(buttons[1].disabled,true);assert.equal(fields.children[0].children.length,0);
});
