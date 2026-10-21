import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeTemuMessages,storeTemuConversation,temuMessagesService} from '../src/temu-messages.mjs';

// Synthetic fixtures only; never loaded by the application.
test('Temu message storage, combined filters, countries and response evidence',async()=>{
 const engine=new PGlite();await engine.waitReady;
 const db={exec:s=>engine.exec(s),query:(s,p)=>engine.query(s,p),readTransaction:f=>engine.transaction(f)};
 try{
  await initializeTemuMessages(db);await initializeTemuMessages(db);
  const service=temuMessagesService(db,'/unused',{configLoader:async()=>({TEMU_COUNTRIES:{a:'FR',b:'DE'}}),shopLoader:async()=>[{country:'ES'}]});
  const row={shopId:'test-fr',conversationId:'same-id',country:'FR',customer:'TEST ONLY',lastCustomerAt:'2026-10-20T10:00:00Z'};
  await storeTemuConversation(db,{...row,read:true,answered:true});
  assert.equal((await service.list()).rows[0].reply_status,'unknown','read and unsupported reply flag are not evidence');
  await storeTemuConversation(db,{...row,answered:true,replyEvidence:'reply_to_last_customer_message'});
  await storeTemuConversation(db,{...row,shopId:'test-de',country:'DE',lastCustomerAt:'2026-10-20T12:00:00Z',answered:false,replyEvidence:'reply_to_last_customer_message',content:'TEST CONTENT'});
  await storeTemuConversation(db,{...row,conversationId:'unknown',lastCustomerAt:'2026-10-20T11:00:00Z'});
  let list=await service.list();assert.equal(list.total,3);assert.deepEqual(list.countries,['DE','ES','FR']);
  assert.deepEqual(list.rows.map(r=>r.reply_status),['unanswered','unknown','answered']);
  assert.equal(list.rows[0].has_content,true);assert.equal(list.rows[1].has_content,false);
  assert.equal(list.statistics.unanswered,1);assert.equal(list.statistics.unknown,1);
  assert.equal(list.statistics.available,false,'stored counts do not prove messaging API access');
  list=await service.list(new URLSearchParams({country:'FR',response:'answered'}));assert.equal(list.total,1);
  assert.equal(list.statistics.unanswered,0,'country selection scopes the counter');
  const deAnswered=await service.list(new URLSearchParams({country:'DE',response:'answered'}));
  assert.equal(deAnswered.total,0);assert.equal(deAnswered.statistics.unanswered,1,'response filter must not hide the country-wide backlog');
  assert.equal(list.rows[0].shop_id,'test-fr');
  assert.equal((await service.list(new URLSearchParams({country:'DE',response:'answered'}))).total,0);
  assert.equal((await service.list(new URLSearchParams({country:'FR',response:'unknown'}))).total,1);
  list=await service.list(new URLSearchParams({sort:'country'}));assert.deepEqual(list.rows.map(r=>r.country),['DE','FR','FR']);
  assert.equal(list.rows[1].conversation_id,'unknown','latest first within country');
  // Repeated import is idempotent; same identifier in another shop stays distinct.
  await storeTemuConversation(db,{...row,answered:true,replyEvidence:'reply_to_last_customer_message'});
  assert.equal((await service.list()).total,3);
  await storeTemuConversation(db,{...row,lastCustomerAt:'2026-10-19T10:00:00Z'});
  assert.equal((await service.list(new URLSearchParams({response:'answered'}))).total,1,'older data cannot regress the latest observation');
  await storeTemuConversation(db,{...row,lastCustomerAt:'2026-10-21T10:00:00Z'});
  assert.equal((await service.list(new URLSearchParams({response:'answered'}))).total,0,'new customer message resets reply to unknown without evidence');
  for(let i=0;i<26;i++)await storeTemuConversation(db,{...row,conversationId:'page-'+i});
  list=await service.list(new URLSearchParams({page:'999'}));assert.equal(list.page,2);assert.equal(list.rows.length,4);
  assert.equal(list.statistics.unanswered,1,'count covers all pages and excludes unknown statuses');
  for(const params of [{country:"FR'"},{response:'read'},{sort:'bad'},{page:'-1'},{page:'NaN'}])await assert.rejects(service.list(new URLSearchParams(params)),e=>e.status===400);
  await assert.rejects(storeTemuConversation(db,{...row,lastCustomerAt:'bad'}));
 }finally{await engine.close();}
});

test('blocked access stays explicit, checks coalesce and never mark messages synchronized',async()=>{
 const engine=new PGlite();await engine.waitReady;
 const db={exec:s=>engine.exec(s),query:(s,p)=>engine.query(s,p),readTransaction:f=>engine.transaction(f)};
 try{
  await initializeTemuMessages(db);let calls=0;
  const service=temuMessagesService(db,'/unused',{configLoader:async()=>{throw Error('secret');},shopLoader:async()=>[],connect:async()=>{
   calls++;return {clients:new Map([['test-shop',{}]]),countryByMall:new Map([['test-shop','FR']]),config:{},connectionErrors:new Map([['DE',Error('secret')]])};
  }});
  await Promise.all([service.refresh(),service.refresh()]);assert.equal(calls,1);
  assert.equal((await service.refresh()).throttled,true);
  const result=await service.list();assert.equal(result.access.available,false);assert.equal(result.lastSyncAt,null);assert.ok(result.lastCheckAt);
  assert.equal(result.statistics.available,false);
  assert.equal(result.total,0);assert.equal(result.configurationAvailable,false);assert.doesNotMatch(JSON.stringify(result),/secret/);
  const context={p:'/api/temu/messages/refresh',req:{method:'POST'},url:new URL('http://localhost/api/temu/messages/refresh'),user:{role:'viewer'},json:()=>assert.fail('must not respond'),permitted:(u,roles)=>{if(!roles.includes(u.role))throw Object.assign(Error('forbidden'),{status:403});}};
  await assert.rejects(service.routes(context),e=>e.status===403);
  let status;await service.routes({...context,user:{role:'operator'},json:(_r,s)=>{status=s;}});assert.equal(status,409);
  assert.equal(await service.routes({...context,p:'/api/temu/orders'}),false);
 }finally{await engine.close();}
});
