import test from 'node:test';
import assert from 'node:assert/strict';
import {missingFromV3,missingOrdersVerification} from '../src/missing-orders-verification.mjs';

test('strict 24h cutoff, source references and channel matching include archived V3 orders',async()=>{
 const db={query:async(sql)=>{assert.match(sql,/SELECT/);assert.doesNotMatch(sql,/archived\s*=/);return {rows:[{channel:'shopify',reference:'local',source_reference:'#1'},{channel:'temu',reference:'#2'}]};}};
 const rows=['#1','#2','#3','#4'].map((reference,i)=>({channel:'shopify',reference,date:i===3?'2026-10-13T12:00:00Z':'2026-10-12T12:00:00Z'}));
 assert.deepEqual((await missingFromV3(db,rows,'2026-10-01T00:00:00Z','2026-10-13T12:00:00Z')).map(r=>r.reference),['#2','#3']);
});

test('reads Shopify pages and every TEMU mall without country filter or database writes',async()=>{
 const calls=[];const db={query:async(sql)=>{assert.match(sql,/^SELECT/);return {rows:[]};}};
 const makeApi=shop=>({read:async(type,args)=>{calls.push({shop,type,args});return {totalItemNum:1,pageItems:[{parentOrderMap:{parentOrderSn:'PO-'+shop,parentOrderTime:Math.floor(Date.parse('2026-10-11T00:00:00Z')/1000),regionName1:shop==='1'?'France':'Japan'}}]};}});
 let page=0;
 const shopify={read:async()=>({shop:'test.myshopify.com',data:{orders:{nodes:[{id:String(++page),name:'#'+page,createdAt:'2026-10-12T00:00:00Z'}],pageInfo:{hasNextPage:page===1,endCursor:page===1?'next':null}}}})};
 const service=missingOrdersVerification(db,'unused',{shopify,connect:async()=>({clients:new Map([['1',makeApi('1')],['2',makeApi('2')]]),countryByMall:new Map(),connectionErrors:new Map()}),now:()=>Date.parse('2026-10-14T00:00:00Z')});
 let result;const request=async b=>{await service({p:'/api/missing-orders/verify',req:{method:'POST'},res:{},user:{id:'user'},permitted:()=>{},body:async()=>b,json:(_res,_status,data)=>result=data});return result;};
 await request({days:28});const runId=result.runId;
 for(let i=0;i<10&&!result.done;i++)await request({runId});
 assert.equal(result.complete,true);assert.equal(result.rows.length,4);assert.equal(calls.length,2);assert.equal(result.rows.at(-1).country,'Japan');
});

test('source failure is explicitly incomplete and other sources remain readable',async()=>{
 const service=missingOrdersVerification({query:async()=>({rows:[]})},'unused',{shopify:{read:async()=>{throw Error('unavailable');}},connect:async()=>({clients:new Map(),countryByMall:new Map(),connectionErrors:new Map([['DE',Error('private credential')]])})});
 let result;const request=async b=>service({p:'/api/missing-orders/verify',req:{method:'POST'},user:{id:'u'},permitted:()=>{},body:async()=>b,json:(_r,_s,data)=>result=data});
 await request({days:28});const runId=result.runId;await request({runId});await request({runId});
 assert.equal(result.done,true);assert.equal(result.complete,false);assert.equal(result.errors.length,2);assert.doesNotMatch(JSON.stringify(result),/private credential/);
});


test('missing-order verification remains wired alongside manual cancellation refresh',async()=>{
 const {readFile}=await import('node:fs/promises');
 const server=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
 const page=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 for(const asset of ['missing-orders-verification','manual-platform-cancellation']){
  assert.ok(page.includes('src="/'+asset+'.js?'));
  assert.ok(server.includes("'/"+asset+".js'"));
 }
 assert.ok(server.includes("import {missingOrdersVerification} from './missing-orders-verification.mjs'"));
 assert.ok(server.includes('const verifyMissingOrders=missingOrdersVerification(db,directory)'));
 assert.ok(server.includes('if(await verifyMissingOrders({p,req,res,user,permitted,body,json}))return'));
 assert.ok(server.includes('await platformCancellationRefresh.next(await body(req),user)'));
});
