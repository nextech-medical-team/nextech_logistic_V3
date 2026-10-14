import test from 'node:test';
import assert from 'node:assert/strict';
import {connectTemuShops} from '../src/temu-shop-clients.mjs';
import {excelLabelShops} from '../scripts/temu-excel-labels.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {resolveExcelTemuShop} from '../src/temu-excel-shop.mjs';
const config={TEMU_APP_KEY:'A',TEMU_APP_SECRET:'secret',TEMU_ACCESS_TOKEN:'root',TEMU_COUNTRIES:{root:'FR',associated:'IT'}};
function fixture(){
 const seen=[];
 const apiFactory=c=>({token:c.TEMU_ACCESS_TOKEN,async read(type){
  assert.equal(type,'bg.open.accesstoken.info.get');seen.push(c.TEMU_ACCESS_TOKEN);
  if(c.TEMU_ACCESS_TOKEN==='root')return {mallId:'root',associatedMallTokenList:[{mallId:'associated',accessToken:'associatedToken'}]};
  if(c.TEMU_ACCESS_TOKEN==='eplgood')return {mallId:'vault'};
  throw Object.assign(Error('quota'),{code:'source_budget_deferred'});
 }});
 const shopLoader=async()=>[{country:'ES',appKey:'A',appSecret:'secret',accessToken:'eplgood'},{country:'BE',appKey:'A',appSecret:'secret',accessToken:'eplbad'}];
 return {apiFactory,shopLoader,configLoader:async()=>config,seen};
}
test('Excel uses the same root, associated tokens and vault filtering as the existing API connection',async()=>{
 const a=fixture(),b=fixture();
 const direct=await connectTemuShops('/unused',a);
 const excel=await excelLabelShops('/unused',{factory:b.apiFactory,shopLoader:b.shopLoader,configLoader:b.configLoader});
 assert.deepEqual([...excel.keys()],[...direct.clients.keys()]);assert.deepEqual(a.seen,b.seen);
 assert.deepEqual(a.seen,['root','eplgood','eplbad']);
 for(const [mall,api] of direct.clients)assert.equal(excel.get(mall).api.token,api.token);
 assert.equal(excel.get('root').country,'FR');assert.equal(excel.get('associated').country,'IT');assert.equal(excel.get('vault').country,'ES');
 assert.equal(direct.connectionErrors.get('BE').code,'source_budget_deferred');
});
test('country reconnect preserves prior clients and records only the relevant vault failure',async()=>{
 const f=fixture(),prior={};const connected=await connectTemuShops('/unused',{...f,country:'BE',clients:new Map([['previous',prior]])});
 assert.equal(connected.clients.get('previous'),prior);assert.deepEqual(f.seen,['root','eplbad']);assert.equal(connected.connectionErrors.size,1);
});
test('automatic Excel connection cannot silently omit a failed shop authorization',async()=>{
 const f=fixture();
 await assert.rejects(connectTemuShops('/unused',{...f,country:'BE',strict:true}),{code:'source_budget_deferred'});
});
test('automatic Excel shop discovery searches every country and uses the matching API client',async()=>{
 const calls=[],o={reference:'PO-TEST',address:{country:'FR'}},lines=[{source_line:'item',source_sku:'SKU',quantity:2}];
 const detail={parentOrderMap:{parentOrderSn:o.reference},orderList:[{orderSn:'item',quantity:2,productList:[{extCode:'SKU'}]}]};
 const local=temuLocalService({},'/unused',{
  configLoader:async()=>({...config,TEMU_COUNTRIES:{root:'IT',associated:'FR'}}),shopLoader:async()=>[],
  apiFactory:c=>({async read(method){calls.push([c.TEMU_ACCESS_TOKEN,method]);if(method==='bg.open.accesstoken.info.get')return {mallId:'root',associatedMallTokenList:[{mallId:'associated',accessToken:'second'}]};return c.TEMU_ACCESS_TOKEN==='second'?detail:{};}})
 });
 const resolved=await local.resolveExcelShop(o,lines);
 assert.equal(resolved.mallId,'associated');assert.equal(resolved.detail,detail);
 assert.deepEqual(calls,[['root','bg.open.accesstoken.info.get'],['root','bg.order.detail.v2.get'],['second','bg.order.detail.v2.get']]);
});
test('Excel preparation finds a vault shop using its own application credentials and token format',async()=>{
 const o={reference:'PO-RO-TEST',address:{country:'RO'}},lines=[{source_line:'item',source_sku:'570315',quantity:1}];
 const detail={parentOrderMap:{parentOrderSn:o.reference},orderList:[{orderSn:'item',quantity:1,productList:[{extCode:'570315'}]}]},calls=[];
 const local=temuLocalService({},'/unused',{
  configLoader:async()=>config,
  shopLoader:async()=>[{country:'IT',appKey:'RO-app',appSecret:'RO-secret',accessToken:'shop-token'}],
  apiFactory:c=>({async read(method){
   calls.push([c.TEMU_ACCESS_TOKEN,method]);
   if(c.TEMU_ACCESS_TOKEN==='root')return method==='bg.open.accesstoken.info.get'?{mallId:'root'}:{};
   assert.equal(c.TEMU_APP_KEY,'RO-app');assert.equal(c.TEMU_APP_SECRET,'RO-secret');assert.equal(c.TEMU_ACCESS_TOKEN,'shop-token');
   return method==='bg.open.accesstoken.info.get'?{mallId:'romanian-shop'}:detail;
  }})
 });
 assert.equal((await local.resolveExcelShop(o,lines)).mallId,'romanian-shop');
 assert.deepEqual(calls,[['root','bg.open.accesstoken.info.get'],['shop-token','bg.open.accesstoken.info.get'],['root','bg.order.detail.v2.get'],['shop-token','bg.order.detail.v2.get']]);
});
test('later order reads reconnect the identified shop even when its configured country differs from delivery',async()=>{
 const calls=[],o={reference:'PO-167-123456789',address:{country:'RO'},source_payload:{mallId:'vault'}};
 const local=temuLocalService({query:async()=>({rows:[o]})},'/unused',{
  configLoader:async()=>config,shopLoader:async()=>[{country:'IT',appKey:'other',appSecret:'secret',accessToken:'vault-token'}],
  apiFactory:c=>({read:async method=>{
   calls.push([c.TEMU_ACCESS_TOKEN,method]);
   if(method==='bg.open.accesstoken.info.get')return {mallId:c.TEMU_ACCESS_TOKEN==='root'?'root':'vault'};
   throw Error('fixture reached the identified shop');
  }})
 });
 await assert.rejects(local.diagnose(o.reference),/fixture reached the identified shop/);
 assert.ok(calls.some(([token,method])=>token==='vault-token'&&method!=='bg.open.accesstoken.info.get'));
});
test('incomplete vault credentials block strict discovery instead of silently hiding the shop',async()=>{
 const f=fixture();
 await assert.rejects(connectTemuShops('/unused',{...f,country:'RO',strict:true,shopLoader:async()=>[{country:'RO',appKey:'other',accessToken:'token'}]}),/Accès incomplets.*RO/);
});
test('associated vault shops retain the application credentials that issued their tokens',async()=>{
 const connected=await connectTemuShops('/unused',{
  configLoader:async()=>config,shopLoader:async()=>[{country:'RO',appKey:'other-app',appSecret:'other-secret',accessToken:'vault-token'}],
  apiFactory:c=>({config:c,read:async()=>c.TEMU_ACCESS_TOKEN==='root'?{mallId:'root'}:{mallId:'vault',associatedMallTokenList:[{mallId:'linked',accessToken:'linked-token'}]}})
 });
 const linked=connected.clients.get('linked').config;
 assert.equal(linked.TEMU_APP_KEY,'other-app');assert.equal(linked.TEMU_APP_SECRET,'other-secret');assert.equal(linked.TEMU_ACCESS_TOKEN,'linked-token');
});
test('discovery distinguishes missing country access from an order absent in consulted shops',async()=>{
 const o={reference:'PO-RO-TEST',address:{country:'RO'}};
 await assert.rejects(resolveExcelTemuShop(o,[],[]),/Aucune boutique.*RO/);
 await assert.rejects(resolveExcelTemuShop(o,[],[{mallId:'shop',api:{read:async()=>({})}}]),/PO-RO-TEST introuvable.*1 boutique.*RO/);
});
