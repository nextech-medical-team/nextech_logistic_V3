import test from 'node:test';
import assert from 'node:assert/strict';
import {connectTemuShops} from '../src/temu-shop-clients.mjs';
import {excelLabelShops} from '../scripts/temu-excel-labels.mjs';
const config={TEMU_APP_KEY:'A',TEMU_APP_SECRET:'secret',TEMU_ACCESS_TOKEN:'root',TEMU_COUNTRIES:{root:'FR',associated:'IT'}};
function fixture(){
 const seen=[];
 const apiFactory=c=>({token:c.TEMU_ACCESS_TOKEN,async read(type){
  assert.equal(type,'bg.open.accesstoken.info.get');seen.push(c.TEMU_ACCESS_TOKEN);
  if(c.TEMU_ACCESS_TOKEN==='root')return {mallId:'root',associatedMallTokenList:[{mallId:'associated',accessToken:'associatedToken'}]};
  if(c.TEMU_ACCESS_TOKEN==='eplgood')return {mallId:'vault'};
  throw Object.assign(Error('quota'),{code:'source_budget_deferred'});
 }});
 const shopLoader=async()=>[{country:'ES',appKey:'A',accessToken:'eplgood'},{country:'BE',appKey:'A',accessToken:'eplbad'},{country:'DE',appKey:'different',accessToken:'eplskip'},{country:'NL',appKey:'A',accessToken:'invalid'}];
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
