import test from 'node:test';
import assert from 'node:assert/strict';
import {erplainFetch,erplainRetryDelay,erplainRequestInterval} from '../src/erplain-transport.mjs';
import {quotaReadRetryAt} from '../src/erplain-quota-wait.mjs';
const response=value=>new Response('{}',{status:429,headers:value==null?{}:{'retry-after':value}});
test('explicit retry delays survive transport and queued recovery without a minute floor',()=>{
 for(const [header,ms] of [['2',2000],['10',10000],['120',120000],['0',1000],['0.5',1000]]){
  const delay=erplainRetryDelay(response(header),3);assert.equal(delay,ms);
  assert.equal(Date.parse(quotaReadRetryAt({retryAfter:delay/1000,erplainRequestNotSent:true,erplainProviderRateLimited:true},0)),Math.max(2000,ms));
 }
 const now=Date.parse('2026-10-15T10:00:00Z');assert.equal(erplainRetryDelay(response('Thu, 15 Oct 2026 10:00:12 GMT'),0,now),12000);
 for(const header of [null,'invalid','-1'])assert.equal(erplainRetryDelay(response(header)),60000);
 assert.equal(erplainRetryDelay(response(null),4),900000);
 for(const retryAfter of [undefined,null,'',NaN,Infinity,-1])assert.equal(Date.parse(quotaReadRetryAt({retryAfter},0)),60000);
});
test('only official v2 GraphQL endpoint gets faster spacing below 2 requests per second',async()=>{
 assert.equal(erplainRequestInterval('https://api.erplain.app/graphql'),600);
 for(const url of ['https://api.erplain.app/file/1','https://api.erplain.app/vapor/signed-storage-url','https://example.test/graphql'])assert.equal(erplainRequestInterval(url),1600);
 const calls=[];let slots=0;
 await erplainFetch({apiKey:'fake'},'https://api.erplain.app/graphql',()=>({method:'POST'}),{readOnly:true,slot:async(key,interval)=>{assert.equal(key,'erplain:shared');assert.equal(interval,600);slots++;},fetchImpl:async()=>{calls.push('sent');return calls.filter(x=>x==='sent').length===1?response('2'):new Response('{"data":{}}');},defer:async(key,ms)=>{assert.equal(key,'erplain:shared');assert.equal(ms,2000);calls.push('pause');}});
 assert.equal(slots,2);assert.deepEqual(calls,['sent','pause','sent']);
});

test('concurrent v2 connectors share spacing and never send three calls in one second',async()=>{
 const sent=[];
 await Promise.all(Array.from({length:5},(_,i)=>erplainFetch({apiKey:'fake-'+i},'https://api.erplain.app/graphql',()=>({method:'POST'}),{readOnly:true,fetchImpl:async()=>{sent.push(Date.now());return new Response('{"data":{}}');}})));
 assert.equal(sent.length,5);
 for(let i=2;i<sent.length;i++)assert.ok(sent[i]-sent[i-2]>=1000,'all connectors must respect the shared two-per-second cap');
});
