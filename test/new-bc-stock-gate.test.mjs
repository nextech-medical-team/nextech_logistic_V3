import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNewBcStock} from '../src/new-bc-stock-gate.mjs';
import {publishIncrementalBc} from '../src/bc-numbering.mjs';
import {newSalesBcInput} from '../src/erplain-live-workflow.mjs';
const conn=data=>({data,paginatorInfo:{hasMorePages:false}});
function fixture(stock=94){
 const variant={id:642510,sku:'TR03',track_inventory:true,stock_levels:conn([{location:{id:100934},on_hand:stock,available:stock,incoming:35200}])};
 const line={type:'normal',variant:{id:642510,sku:'TR03'},location:{id:100934},quantity:200};
 const calls=[];const api={request:async(q,v)=>{calls.push({q,v});assert.match(q,/^query /);return {Variants:conn([variant])};}};
 return {variant,line,api,calls,run:lines=>assertNewBcStock(api,lines||[line])};
}
test('SHO00745275: 94 real units cannot cover 200 despite 35200 incoming',async()=>{await assert.rejects(()=>fixture().run(),/200.*94.*106/);});
for(const channel of ['amazon','shopify','relay','temu','samples','rakuten','tender'])test(channel+' BC input is refused by the shared stock gate at 94/200',async()=>{
 const f=fixture(),source={channel,id:'coverage',reference:'CASE',source_date:'17/10/2026',source_payload:{},documentMetadata:{},address:{},currency:{id:1},erp_live:{customer:{id:1}},pricing:{tax_type:'exclusive',items:[f.line]}};
 const input=newSalesBcInput(source,1);
 assert.equal(input.update_stock,true);
 await assert.rejects(()=>assertNewBcStock(f.api,input.line_items,{TR03:f.variant}),/stock insuffisant/);
});
for(const stock of [200,300])test('sufficient real stock '+stock,async()=>{assert.equal(await fixture(stock).run(),true);});
test('duplicate lines sum demand against shared stock',async()=>{const f=fixture(200);await assert.rejects(()=>f.run([f.line,f.line]),/400/);assert.equal(f.calls.length,1);});
test('unknown tracking policy refuses',async()=>{const f=fixture();delete f.variant.track_inventory;await assert.rejects(()=>f.run());});
test('incomplete pagination refuses',async()=>{const f=fixture();f.variant.stock_levels.paginatorInfo.hasMorePages=true;await assert.rejects(()=>f.run());});
test('missing location refuses',async()=>{const f=fixture();f.variant.stock_levels.data=[];await assert.rejects(()=>f.run());});
test('unknown balances refuse',async()=>{const f=fixture();f.variant.stock_levels.data[0].on_hand=null;await assert.rejects(()=>f.run());});
test('untracked product permitted',async()=>{const f=fixture();f.variant.track_inventory=false;assert.equal(await f.run(),true);});
test('fresh shortage prevents activation mutation',async()=>{
 const f=fixture(),mutations=[];const api={request:async(q,v)=>{
  if(q.includes('V3BcNumberRead'))return {Order:{id:1949944,status:'unpublished',update_stock:true,line_items:[f.line]}};
  if(q.includes('V3BcNumber('))return {DocumentNumberingContext:{preview:'C0016130',manual_override_allowed_effective:true}};
  if(q.startsWith('mutation')){mutations.push(q);throw Error('forbidden mutation');}
  return f.api.request(q,v);
 }};
 await assert.rejects(()=>publishIncrementalBc(api,1949944,{verify:()=>{},datedAt:'2026-10-17',lock:fn=>fn(),expectedStockPolicy:true,beforePublish:bc=>assertNewBcStock(api,bc.line_items)}),/stock insuffisant/);
 assert.equal(mutations.length,0);
});
test('active BC remains readable without a stock gate',async()=>{
 const bc={id:1,status:'active',update_stock:true},api={request:async()=>({Order:bc})};
 assert.equal(await publishIncrementalBc(api,1,{verify:()=>{},lock:fn=>fn(),beforePublish:()=>{throw Error('existing BC');}}),bc);
});
