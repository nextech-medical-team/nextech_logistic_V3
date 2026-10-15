import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePrices,priceVerification} from '../src/price-verification.mjs';
const start='2026-10-13T20:00:00.000Z',end='2026-10-14T08:00:00.000Z';
function setup(orders){
 const calls=[];
 const db={async query(sql,[channel,country,cursor,limit]){return {rows:orders.filter(o=>o.id>cursor).slice(0,limit)};}};
 const shopify={async read(query,{search}){calls.push(search);const name=search.slice(5);return {data:{orders:{nodes:[{id:'gid://shopify/Order/1',name,currentTotalPriceSet:{shopMoney:{amount:'10',currencyCode:'EUR'}}}],pageInfo:{hasNextPage:false}}}};}};
 return {api:priceVerification(db,null,{shopify}),calls};
}
const order=(id,date)=>({id,channel:'shopify',reference:id,source_date:date,erp_live:{bc:{id:'bc',total:10,currency:{label:'EUR'}}}});
test('date interval includes both boundaries and never reads prices outside it',async()=>{
 const {api,calls}=setup([order('a','2026-10-13T19:59:59Z'),order('b',start),order('c',end),order('d','2026-10-14T08:00:01Z'),order('e',null),order('f','invalid')]);
 const input={channel:'shopify',country:'BE',start,end};
 const first=await api.next(input);assert.equal(first.cursor,'b');assert.equal(first.result.status,'same');
 const second=await api.next({...input,cursor:first.cursor});assert.equal(second.cursor,'c');
 assert.deepEqual(await api.next({...input,cursor:second.cursor}),{done:true});
 assert.deepEqual(calls,['name:b','name:c']);
});
test('scans beyond a full excluded batch',async()=>{
 const orders=Array.from({length:101},(_,i)=>order(String(i).padStart(3,'0'),i===100?start:'2026-10-01T00:00:00Z'));
 const {api}=setup(orders);assert.equal((await api.next({channel:'shopify',country:'BE',start,end})).cursor,'100');
});
test('rejects incomplete, malformed and reversed intervals before querying',async()=>{
 const {api}=setup([]);
 for(const range of [{start},{start:'bad',end},{start:end,end:start}])await assert.rejects(api.next({channel:'shopify',country:'BE',...range}),/Intervalle/);
});
test('empty interval preserves verification of all orders',async()=>{
 const {api}=setup([order('a',null)]);assert.equal((await api.next({channel:'shopify',country:'BE',start:null,end:null})).cursor,'a');
});

test('percentage uses platform total, signed values and two decimal rounding',()=>{
 const compare=(bc,source)=>comparePrices({amount:bc,currency:'EUR'},{amount:source,currency:'EUR'}).differencePercent;
 assert.equal(compare(110,100),10);
 assert.equal(compare(90,100),-10);
 assert.equal(compare(10,10),0);
 assert.equal(compare(10,3),233.33);
 assert.equal(compare(0,0),0);
 assert.equal(compare(10,0),null);
 assert.equal(compare(70.43,70.43),0);
});
