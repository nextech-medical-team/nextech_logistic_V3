import test from 'node:test';
import assert from 'node:assert/strict';
import {connectTemuShops} from '../src/temu-shop-clients.mjs';
import {excelLabelShops} from '../scripts/temu-excel-labels.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {resolveExcelTemuShop} from '../src/temu-excel-shop.mjs';
import {temuShopError} from '../src/temu-shop-error.mjs';
const config={TEMU_APP_KEY:'A',TEMU_APP_SECRET:'secret',TEMU_ACCESS_TOKEN:'root',TEMU_COUNTRIES:{root:'FR',associated:'IT'}};
test('application refusal identifies principal authorization without exposing credentials',async()=>{
 const failure=Object.assign(Error('The application information query is abnormal'),{code:'4000000'});
 await assert.rejects(connectTemuShops('/unused',{configLoader:async()=>config,shopLoader:async()=>[],apiFactory:()=>({read:async()=>{throw failure;}})}),e=>e.code==='4000000'&&/accès principal.*autorisation/.test(e.message)&&/clé d’application/.test(e.message));
 const redacted=temuShopError(Object.assign(Error('access-token app-secret'),{code:'4000000'}),'boutique SI',['access-token','app-secret']);
 assert.doesNotMatch(redacted.message,/access-token|app-secret/);
 const stopping=Object.assign(Error('stopping'),{code:'TEMU_STOPPING'});assert.equal(temuShopError(stopping,'shop'),stopping);
});
test('unrelated vault authorization failure names its country instead of blaming delivery country',async()=>{
 const f=fixture();
 await assert.rejects(connectTemuShops('/unused',{...f,strict:true,apiFactory:c=>({read:async()=>{
  if(c.TEMU_ACCESS_TOKEN==='root')return {mallId:'root'};
  throw Object.assign(Error('The application information query is abnormal'),{code:'4000000'});
 }})}),e=>e.code==='4000000'&&/boutique ES du coffre/.test(e.message));
});
test('order lookup failure identifies the shop and requested reference',async()=>{
 await assert.rejects(resolveExcelTemuShop({reference:'PO-181-TEST'},[],[{mallId:'shop-1',api:{read:async()=>{throw Object.assign(Error('refused'),{code:'4000000'});}}}]),e=>e.code==='4000000'&&/boutique shop-1.*PO-181-TEST/.test(e.message));
});
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
const unavailable=()=>Object.assign(Error('The application information query is abnormal'),{code:'4000000'});
const order={reference:'PO-141-19314940851830296',address:{country:'NL'}},orderLines=[{source_line:'item',source_sku:'SKU',quantity:1}];
const orderDetail={parentOrderMap:{parentOrderSn:order.reference},orderList:[{orderSn:'item',quantity:1,productList:[{extCode:'SKU'}]}]};
const owner={mallId:'owner',api:{read:async()=>orderDetail}};
test('unavailable application does not prevent an exact match from another shop',async()=>{
 const refused={mallId:'refused',api:{read:async()=>{throw unavailable();}}};
 const result=await resolveExcelTemuShop(order,orderLines,[refused,owner]);
 assert.equal(result.mallId,'owner');assert.equal(result.shopWarnings.length,1);
 await assert.rejects(resolveExcelTemuShop(order,orderLines,[refused]),/abnormal/);
 await assert.rejects(resolveExcelTemuShop(order,orderLines,[refused,owner,{...owner,mallId:'duplicate'}]),/ambigu/);
 await assert.rejects(resolveExcelTemuShop(order,[{...orderLines[0],quantity:2}],[refused,owner]));
});
test('timeouts quotas and other application errors still block despite an exact match',async()=>{
 for(const error of [Object.assign(Error('quota'),{code:'source_budget_deferred'}),Error('timeout'),Object.assign(Error('other refusal'),{code:'4000000'}),Object.assign(Error('stop'),{code:'TEMU_STOPPING'})]){
  await assert.rejects(resolveExcelTemuShop(order,orderLines,[owner,{mallId:'failed',api:{read:async()=>{throw error;}}}]),e=>e.message.includes(error.message));
 }
});
test('unavailable principal application permits vault discovery and subsequent reconnect',async()=>{
 const stored={...order,source_payload:{mallId:'owner'}};
 const calls=[];
 const local=temuLocalService({query:async()=>({rows:[stored]})},'/unused',{
  configLoader:async()=>config,shopLoader:async()=>[{country:'FR',appKey:'other',appSecret:'other-secret',accessToken:'vault'}],
  apiFactory:c=>({read:async method=>{
   calls.push([c.TEMU_ACCESS_TOKEN,method]);
   if(c.TEMU_ACCESS_TOKEN==='root')throw unavailable();
   if(method==='bg.open.accesstoken.info.get')return {mallId:'owner'};
   if(method==='bg.order.detail.v2.get')return orderDetail;
   throw Error('confirmed owner diagnostic');
  }})
 });
 const result=await local.resolveExcelShop(order,orderLines);
 assert.equal(result.mallId,'owner');assert.match(result.shopWarnings[0].message,/accès principal/);
 const diagnostic=await local.diagnose(order.reference);assert.match(diagnostic.errors[0].message,/confirmed owner diagnostic/);
 assert.equal(calls.filter(([token,method])=>token==='vault'&&method==='bg.open.accesstoken.info.get').length,2);
});
test('unavailable vault application is recorded while another shop can confirm the order',async()=>{
 const connected=await connectTemuShops('/unused',{
  configLoader:async()=>config,shopLoader:async()=>[{country:'BE',appKey:'B',appSecret:'s',accessToken:'failed'}],strict:true,allowUnavailableApplications:true,
  apiFactory:c=>({read:async method=>{
   if(c.TEMU_ACCESS_TOKEN==='failed')throw unavailable();
   return method==='bg.open.accesstoken.info.get'?{mallId:'owner'}:orderDetail;
  }})
 });
 const result=await resolveExcelTemuShop(order,orderLines,[...connected.clients].map(([mallId,api])=>({mallId,api})),connected.unavailableApplications);
 assert.equal(result.mallId,'owner');assert.match(result.shopWarnings[0].message,/boutique BE/);
 await assert.rejects(resolveExcelTemuShop(order,orderLines,[],connected.unavailableApplications),/boutique BE/);
});
test('Excel without a shop binds only on later TEMU access; refusal leaves BC preparation intact',async()=>{
 const stored={...order,id:'excel',channel:'temu',source_payload:{origin:'temu_excel',temuExcelPreparation:{jobId:'prepared'}}};
 let refused=true,writes=0;
 const db={query:async(sql,args)=>{
  if(sql.startsWith('SELECT * FROM lines'))return {rows:orderLines};
  if(sql.startsWith('UPDATE orders')){writes++;stored.source_payload={...stored.source_payload,...JSON.parse(args[1])};return {rows:[]};}
  return {rows:[stored]};
 }};
 const local=temuLocalService(db,'/unused',{
  configLoader:async()=>config,shopLoader:async()=>[],apiFactory:()=>({read:async method=>{
   if(refused)throw unavailable();
   if(method==='bg.open.accesstoken.info.get')return {mallId:'owner'};
   if(method==='bg.order.detail.v2.get')return orderDetail;
   if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
   throw Error(method);
  }})
 });
 await assert.rejects(local.diagnose(order.reference),/abnormal/);
 assert.equal(writes,0);assert.equal(stored.source_payload.temuExcelPreparation.jobId,'prepared');
 refused=false;const result=await local.diagnose(order.reference);
 assert.equal(result.errors.length,0);assert.equal(stored.source_payload.mallId,'owner');assert.equal(writes,1);
 assert.equal(stored.source_payload.temuDirect,undefined); // Shop binding alone is not purchase authorization.
});
test('explicit order-not-found in another shop does not reject the verified owner',async()=>{
 const absent={mallId:'absent',api:{read:async()=>{throw Object.assign(Error('TEMU refuse l’opération : 140020002 Order not found'),{code:'140020002'});}}};
 for(const candidates of [[absent,owner],[owner,absent]])assert.equal((await resolveExcelTemuShop(order,orderLines,candidates)).mallId,'owner');
 await assert.rejects(resolveExcelTemuShop(order,orderLines,[absent]),/introuvable.*1 boutique/);
 await assert.rejects(resolveExcelTemuShop(order,orderLines,[absent,owner,{...owner,mallId:'duplicate'}]),/ambigu/);
 await assert.rejects(resolveExcelTemuShop(order,[{...orderLines[0],quantity:2}],[absent,owner]),/quantités/);
 for(const failure of [Object.assign(Error('authorization refused'),{code:'140020002'}),Object.assign(Error('Order not found'),{code:'OTHER'})]){
  await assert.rejects(resolveExcelTemuShop(order,orderLines,[owner,{mallId:'failed',api:{read:async()=>{throw failure;}}}]),e=>e.code===failure.code);
 }
});

test('legacy Excel with a published BL can find its shop without import job metadata',async()=>{
 const stored={...order,id:'excel',channel:'temu',erp_live:{bc:{id:'bc'},bl:{id:'bl',status:'ready_to_ship'}},source_payload:{origin:'temu_excel'}};
 let refused=true,writes=0;
 const db={query:async(sql,args)=>{
  if(sql.startsWith('SELECT * FROM lines'))return {rows:orderLines};
  if(sql.startsWith('UPDATE orders')){writes++;stored.source_payload={...stored.source_payload,...JSON.parse(args[1])};return {rows:[]};}
  return {rows:[stored]};
 }};
 const local=temuLocalService(db,'/unused',{
  configLoader:async()=>config,shopLoader:async()=>[],apiFactory:()=>({read:async method=>{
   if(refused)throw unavailable();
   if(method==='bg.open.accesstoken.info.get')return {mallId:'owner'};
   if(method==='bg.order.detail.v2.get')return orderDetail;
   if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
   throw Error(method);
  }})
 });
 await assert.rejects(local.diagnose(order.reference),/abnormal/);
 assert.equal(writes,0);assert.equal(stored.erp_live.bl.id,'bl');
 refused=false;const result=await local.diagnose(order.reference);
 assert.equal(result.errors.length,0);assert.equal(stored.source_payload.mallId,'owner');assert.equal(writes,1);
 assert.equal(stored.source_payload.temuDirect,undefined); // Shop binding alone is not purchase authorization.
});
