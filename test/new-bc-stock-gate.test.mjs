import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNewBcStock} from '../src/new-bc-stock-gate.mjs';
import {publishIncrementalBc} from '../src/bc-numbering.mjs';
import {newSalesBcInput} from '../src/erplain-live-workflow.mjs';
import {representativeLabels} from '../src/erplain-document-metadata.mjs';
const conn=data=>({data,paginatorInfo:{hasMorePages:false}});
function fixture(stock=94){
 const variant={id:642510,sku:'TR03',track_inventory:true,stock_levels:conn([{location:{id:100934},on_hand:stock,available:stock,incoming:35200}])};
 const line={type:'normal',variant:{id:642510,sku:'TR03'},location:{id:100934},quantity:200};
 const calls=[];const api={request:async(q,v)=>{calls.push({q,v});assert.match(q,/^query /);return {Variants:conn([variant])};}};
 return {variant,line,api,calls,run:lines=>assertNewBcStock(api,lines||[line])};
}
test('SHO00745275: 94 real units cannot cover 200 despite 35200 incoming',async()=>{await assert.rejects(()=>fixture().run(),/200.*94.*106/);});
for(const channel of Object.keys(representativeLabels))test(channel+' BC input is refused by the shared stock gate at 94/200',async()=>{
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

function rereadFixture(stock){
 const f=fixture(),initial=f.api.request;f.variant.stock_levels=conn([]);
 f.api.request=async(q,v)=>{
  if(!q.includes('V3NewBcStockDetail'))return initial(q,v);
  f.calls.push({q,v});assert.match(q,/^query /);assert.deepEqual(v,{id:'642510',locations:[100934]});
  return {Variant:{...f.variant,stock_levels:conn(stock)}};
 };
 return f;
}
test('missing list stock is recovered by an exact variant read before BC',async()=>{
 const f=rereadFixture([{location:{id:100934},on_hand:300,available:200}]);
 assert.equal(await f.run(),true);assert.equal(f.calls.length,2);
});
test('explicit zero in the exact read is a shortage, never an API absence',async()=>{
 const f=rereadFixture([{location:{id:100934},on_hand:0,available:0}]);
 await assert.rejects(()=>f.run(),/stock insuffisant.*200 nécessaires, 0 utilisables, manque 200/);
});
test('an empty exact read stays unknown with SKU and warehouse in the diagnosis',async()=>{
 const f=rereadFixture([]);
 await assert.rejects(()=>f.run(),/Stock non vérifiable.*TR03.*100934.*après relecture/);
});
test('another warehouse cannot satisfy the selected warehouse',async()=>{
 const f=rereadFixture([{location:{id:999},on_hand:9000,available:9000}]);
 await assert.rejects(()=>f.run(),/Stock non vérifiable.*100934/);
});
test('exact read rejects mismatched identity or tracking policy',async()=>{
 for(const patch of [{id:999},{sku:'OTHER'},{track_inventory:false}]){
  const f=rereadFixture([{location:{id:100934},on_hand:500,available:500}]),request=f.api.request;
  f.api.request=async(q,v)=>{const r=await request(q,v);if(r.Variant)Object.assign(r.Variant,patch);return r;};
  await assert.rejects(()=>f.run(),/identité produit non confirmée/);
 }
});
test('exact read requires complete pagination, unique warehouse and numeric balances',async()=>{
 for(const kind of ['pagination','duplicate','null','blank','boolean']){
  const f=rereadFixture([{location:{id:100934},on_hand:500,available:500}]),request=f.api.request;
  f.api.request=async(q,v)=>{const r=await request(q,v);if(r.Variant){const c=r.Variant.stock_levels;
   if(kind==='pagination')c.paginatorInfo.hasMorePages=true;
   if(kind==='duplicate')c.data.push(c.data[0]);
   if(kind==='null')c.data[0].available=null;
   if(kind==='blank')c.data[0].available='';
   if(kind==='boolean')c.data[0].available=false;
  }return r;};
  await assert.rejects(()=>f.run(),/Stock non vérifiable/);
 }
});
test('duplicate lines share the detail read while preserving total demand',async()=>{
 const f=rereadFixture([{location:{id:100934},on_hand:300,available:300}]);
 await assert.rejects(()=>f.run([f.line,f.line]),/400 nécessaires.*300 utilisables/);assert.equal(f.calls.length,2);
});
test('detail read network refusal does not become zero or permit BC creation',async()=>{
 const f=rereadFixture([]),request=f.api.request;
 f.api.request=async(q,v)=>{if(q.includes('V3NewBcStockDetail'))throw Error('Erplain HTTP 429');return request(q,v);};
 await assert.rejects(()=>f.run(),/Erplain HTTP 429/);
});

for(const [physical,available,passes] of [[0,0,false],[300,300,true],[300,0,false],[0,300,false]])test('empty stock-level rows use explicit warehouse balances '+physical+'/'+available,async()=>{
 const f=rereadFixture([]),request=f.api.request;
 f.api.request=async(q,v)=>{const r=await request(q,v);if(r.Variant){assert.match(q,/on_hand\(location_ids:\$locations\)/);assert.match(q,/available\(location_ids:\$locations\)/);Object.assign(r.Variant,{physicalAtLocation:physical,availableAtLocation:available});}return r;};
 if(passes)assert.equal(await f.run(),true);else await assert.rejects(()=>f.run(),/stock insuffisant/);
});
test('missing or invalid scoped scalar quantities remain unknown',async()=>{
 for(const patch of [{physicalAtLocation:0},{physicalAtLocation:null,availableAtLocation:0},{physicalAtLocation:0,availableAtLocation:''},{physicalAtLocation:false,availableAtLocation:0}]){
  const f=rereadFixture([]),request=f.api.request;
  f.api.request=async(q,v)=>{const r=await request(q,v);if(r.Variant)Object.assign(r.Variant,patch);return r;};
  await assert.rejects(()=>f.run(),/Stock non vérifiable/);
 }
});
test('scoped balances are never reused for another warehouse',async()=>{
 const f=fixture();f.variant.stock_levels=conn([]);
 f.api.request=async(q,v)=>{
  f.calls.push({q,v});
  if(!q.includes('V3NewBcStockDetail'))return {Variants:conn([f.variant])};
  const stock=v.locations[0]===100934?300:0;
  return {Variant:{...f.variant,physicalAtLocation:stock,availableAtLocation:stock}};
 };
 await assert.rejects(()=>f.run([f.line,{...f.line,location:{id:100935}}]),/stock insuffisant/);
 assert.deepEqual(f.calls.filter(c=>c.q.includes('Detail')).map(c=>c.v.locations),[[100934],[100935]]);
});
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
