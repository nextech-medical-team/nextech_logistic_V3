import test from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceContentFrozen,lifecycleObservation,retirePostBcSourceReview,retireSourceReviewReason,recordPostBcLifecycle,projectFrozenSourceDiagnostics} from '../src/marketplace-content-freeze.mjs';
import {marketplaceChangeFields} from '../src/marketplace-comparison.mjs';
import {readTemuSource} from '../src/temu-catchup-reader.mjs';
import {reconcileTemuCatchup} from '../src/temu-catchup-reconcile.mjs';
import {temuCollector} from '../src/temu-collection.mjs';
import {applyMarketplaceReceipt} from '../src/marketplace-inbox.mjs';
import {shopifyCollector} from '../src/marketplace-collection.mjs';
import {shopifyDiagnosticReader} from '../src/shopify-order-diagnostic.mjs';
import {importOrders} from '../src/imports.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
const reference='PO-069-123456789';
const make=(channel='temu')=>({id:'A',channel,reference:channel==='temu'?reference:'#100',erp_live:{bc:{id:123},bl:{id:456}},source_payload:{id:'100',mallId:'M',sourceShop:channel==='temu'?'M':'example.myshopify.com',temuOrderDetail:{parentOrderMap:{parentOrderTime:1700000000,parentOrderSn:reference,parentOrderStatus:2}},marketplacePendingCorrection:{line_items:[{sku:'changed',quantity:999}]},platformModificationFields:{fields:['articles/quantités']}},issue:'TEMU · Données source différentes : articles/quantités · Rapprochement à vérifier',address:{street:'saved'},label_status:'paid',suspension:{active:true},tracking_status:'in_transit'});
const parent=(status=2)=>({parentOrderSn:reference,parentOrderTime:1700000000,parentOrderStatus:status,updateTime:1700000100});
const provider=(calls,status=2,refund=0)=>({read:async(type)=>{calls.push(type);if(type==='bg.order.list.v2.get')return {totalItemNum:1,pageItems:[{parentOrderMap:parent(status),orderList:[{sku:'IGNORED',quantity:999}]}]};if(type==='bg.order.amount.query')return {parentOrderMap:{parentOrderSn:reference,refundsTotal:{amount:refund,currency:'EUR'},customerPaid:{amount:100,currency:'EUR'}},orderList:[{sku:'IGNORED',quantity:999}]};throw Error('Forbidden post-BC endpoint '+type);}});
test('All three BCs freeze content; absent BC and other channels retain initial controls',()=>{
 for(const channel of ['temu','shopify','amazon']){const o=make(channel);assert.equal(marketplaceContentFrozen(o),true);assert.deepEqual(marketplaceChangeFields(o,{}, {lines:[{sku:'changed',quantity:999}],address:{street:'changed'}}),[]);delete o.erp_live.bc;assert.equal(marketplaceContentFrozen(o),false);o.source_payload.postBcContentFreeze={enabled:true};assert.equal(marketplaceContentFrozen(o),true);}
 assert.equal(marketplaceContentFrozen({...make(),channel:'relay'}),false);
});
test('Retired review cleanup preserves documents, saved source, suspensions and independent issues',async()=>{
 for(const channel of ['temu','shopify','amazon']){const o=make(channel);const before=structuredClone(o),writes=[];o.issue+=' ; Stock insuffisant';await retirePostBcSourceReview({query:async(s,a)=>{writes.push({s,a});return {rows:[]};}},o);
 assert.equal(o.issue,'Stock insuffisant');assert.deepEqual(o.erp_live,before.erp_live);assert.deepEqual(o.address,before.address);assert.deepEqual(o.suspension,before.suspension);assert.equal(o.label_status,before.label_status);assert.deepEqual(o.source_payload.temuOrderDetail,before.source_payload.temuOrderDetail);assert.equal(o.source_payload.marketplacePendingCorrection,undefined);assert.deepEqual(o.source_payload.postBcContentFreeze.retiredReview.payload,before.source_payload.marketplacePendingCorrection);assert.equal(writes.length,1);assert.match(writes[0].s,/SET source_payload=.*issue=/);}
 assert.equal(retireSourceReviewReason(make(),'Annulation à vérifier'),'Annulation à vérifier');
});
test('TEMU frozen reader and collector never request details, SKU, quantities, addresses or logistics',async()=>{
 const o=make(),calls=[],api=provider(calls,3,100);const ob=await readTemuSource(api,reference,{order:o});assert.equal(ob.cancelled,true);assert.equal(ob.refundStatus,'full');assert.equal(ob.payload,undefined);assert.deepEqual(calls,['bg.order.list.v2.get','bg.order.amount.query']);
 calls.length=0;const page=await temuCollector(api,{mallId:'M'}).page({since:'2023-01-01',until:'2026-10-11',knownOrders:[o]});assert.equal(page.items[0].payload.lifecycleOnly,true);assert.equal(page.items[0].payload.lifecycle.refundStatus,'full');assert.deepEqual(calls,['bg.order.list.v2.get','bg.order.amount.query']);
});
test('Refund amounts retain none, partial, full and unknown distinctions',async()=>{
 for(const [amount,expected] of [[0,'none'],[25,'partial'],[100,'full']]){const ob=await readTemuSource(provider([],2,amount),reference,{order:make()});assert.equal(ob.refundStatus,expected);assert.equal(ob.cancelled,false);}
 const ob=await readTemuSource({read:async(type)=>type==='bg.order.list.v2.get'?{totalItemNum:1,pageItems:[{parentOrderMap:parent(3)}]}:{}},reference,{order:make()});assert.equal(ob.cancelled,true);assert.equal(ob.refundStatus,'unknown');assert.equal(ob.complete,false);assert.equal(ob.errors.length,1);
});
test('Late full TEMU responses cannot overwrite frozen preparation',async()=>{
 const o=make(),before=structuredClone(o),writes=[];await reconcileTemuCatchup({query:async(s,a)=>{writes.push(s);return {rows:[]};}},o,{checkedAt:new Date().toISOString(),payload:{detail:{parentOrderMap:parent(3),orderList:[{sku:'changed',quantity:999}]}}});assert.deepEqual(o.erp_live,before.erp_live);assert.deepEqual(o.source_payload.temuOrderDetail,before.source_payload.temuOrderDetail);assert.ok(writes.every(s=>s.startsWith('UPDATE orders SET source_payload=')));
});
test('Frozen inbox bypasses normalization, reception floor and relay rereads',async()=>{
 const o=make('shopify'),writes=[];const tx={query:async(s,a)=>{if(s.startsWith('SELECT * FROM orders'))return {rows:[o]};writes.push(s);return {rows:[]};}};const db={query:async()=>({rows:[{value:{enabled:true,since:'2099-01-01'}}]}),transaction:async fn=>fn(tx)};
 const result=await applyMarketplaceReceipt(db,{channel:'shopify',shop:'example.myshopify.com',payload:{id:'100',name:'#100',updated_at:'2026-10-11T10:00:00Z',financial_status:'partially_refunded',cancelled_at:null,line_items:'INVALID',shipping_lines:[{title:'GLS relay'}]}},{shopifyReader:{order:()=>{throw Error('Forbidden product reread');}}});assert.equal(result.contentFrozen,true);assert.ok(writes.every(s=>s.startsWith('UPDATE orders SET source_payload=')));
});
test('Identity and stale lifecycle protections remain without comparing products',async()=>{
 assert.throws(()=>lifecycleObservation('shopify',{id:'100',name:'#wrong'},{reference:'#100'}),/Identité/);assert.throws(()=>lifecycleObservation('temu',{parentOrderMap:parent()},{reference:'WRONG'}),/Identité/);
 const o=make();o.source_payload.platformLifecycleObservation={checkedAt:'2026-10-11T12:00:00Z',version:1700000300};await assert.rejects(recordPostBcLifecycle({query:()=>{throw Error('Must not write');}},o,lifecycleObservation('temu',{parentOrderMap:parent()},{reference,checkedAt:'2026-10-11T11:00:00Z'})),/antérieure/);
 const amazon=lifecycleObservation('amazon',{orderid:'#100',orderstatus:'Canceled',refundstatus:'partial',sku:'ignored',quantitypurchased:1000},{reference:'#100'});assert.equal(amazon.cancelled,true);assert.equal(amazon.refundStatus,'partial');assert.equal(amazon.sku,undefined);
});
test('Shopify collector and manual diagnostic request only lifecycle fields after BC',async()=>{
 const o=make('shopify'),queries=[],n={id:'gid://shopify/Order/100',name:'#100',createdAt:'2026-10-01T10:00:00Z',updatedAt:'2026-10-11T10:00:00Z',cancelledAt:null,displayFinancialStatus:'REFUNDED',displayFulfillmentStatus:'UNFULFILLED'};
 const c=shopifyCollector({SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_ACCESS_TOKEN:'fixture'}, {fetchImpl:async(u,opt)=>{const q=JSON.parse(opt.body).query;queries.push(q);assert.doesNotMatch(q,/lineItems|shippingAddress|totalPriceSet|sku|quantity|shippingLines/);return {ok:true,status:200,json:async()=>({data:q.includes('orders(')?{orders:{nodes:[n],pageInfo:{hasNextPage:false}}}:{order:n}})};}});
 const page=await c.page({knownOrders:[o],since:'2026-10-01',until:'2026-10-11'});assert.equal(page.items[0].payload.financial_status,'refunded');assert.equal(queries.length,1);
 const reader=shopifyDiagnosticReader({query:async()=>({rows:[o]})},'unused',{loadConfig:async()=>({SHOPIFY_STORE_DOMAIN:'example.myshopify.com'}),collector:()=>c});const diagnostic=await reader.read('A');assert.equal(diagnostic.refundStatus,'full');assert.equal(queries.length,2);
});
test('TEMU manual refresh, diagnostic and amount controls never revalidate frozen products',async()=>{
 const o=make(),calls=[],writes=[];const base=provider(calls,3,25);const api={read:async(t,...a)=>t==='bg.open.accesstoken.info.get'?{mallId:'M'}:base.read(t,...a)};
 const tx={query:async(s,a)=>{if(s.startsWith('SELECT'))return {rows:[o]};writes.push(s);return {rows:[]};}};const db={...tx,transaction:async fn=>fn(tx)};
 const service=temuLocalService(db,'unused',{apiFactory:()=>api,shopLoader:async()=>[],configLoader:async()=>({})});const refresh=await service.diagnose(o.reference);assert.equal(refresh.contentFrozen,true);assert.equal(refresh.cancelled,true);assert.equal(refresh.refundStatus,'partial');assert.ok(writes.every(s=>s.startsWith('UPDATE orders SET source_payload=')));
 const before=calls.length;assert.equal((await service.amounts(o.reference,{force:true})).contentFrozen,true);assert.equal(calls.length,before);assert.equal((await service.diagnose(o.reference)).scope,'cancellation-refund-only');assert.ok(calls.every(t=>['bg.order.list.v2.get','bg.order.amount.query'].includes(t)));
});

test('Amazon repeated import preserves filled BC content while observing cancellation and refund',async()=>{
 const o=make('amazon');o.reference='111-2222222-3333333';o.source_payload.visibilityHold=true;const writes=[];
 const tx={query:async(s,a)=>{if(s.startsWith('SELECT DISTINCT')||s.startsWith('SELECT * FROM orders'))return {rows:[o]};if(s.startsWith('UPDATE orders SET source_payload=')){writes.push({s,a});return {rows:[]};}if(s.startsWith('UPDATE orders SET reference='))return {rows:[]};if(s.startsWith('INSERT INTO orders')||s.startsWith('INSERT INTO lines')||s.startsWith('INSERT INTO jobs')){assert.deepEqual(JSON.parse(a[0]),[]);return {rows:[]};}throw Error('Forbidden content rewrite '+s);}};
 const before=structuredClone(o),file=Buffer.from('order-id\torder-item-id\tsku\tquantity-purchased\torder-status\trefund-status\tpurchase-date\tship-country\tship-postal-code\n111-2222222-3333333\tL1\tCHANGED\t999\tCanceled\tpartial\t2026-10-01\tFR\t75001');const result=await importOrders({transaction:async fn=>fn(tx)},file,'fixture.tsv','amazon');assert.equal(result.created,0);assert.deepEqual(o.erp_live,before.erp_live);assert.deepEqual(o.address,before.address);assert.equal(o.source_payload.visibilityHold,true);const observation=JSON.parse(writes.at(-1).a[1]).platformLifecycleObservation;assert.equal(observation.cancelled,true);assert.equal(observation.refundStatus,'partial');assert.equal(observation.sku,undefined);
});

test('Post-BC processing cards retire obsolete cached source reasons and preserve current independent diagnostics',()=>{const o=make();const reason=o.issue;o.monitoring={result:reason+' ; Stock insuffisant',externalReadIssue:reason,blocked:true};o.temu_job={error:reason};projectFrozenSourceDiagnostics(o);assert.equal(o.monitoring.result,'Stock insuffisant');assert.equal(o.monitoring.externalReadIssue,null);assert.equal(o.temu_job.error,null);assert.equal(o.monitoring.blocked,true);assert.deepEqual(o.erp_live,{bc:{id:123},bl:{id:456}});assert.equal(retireSourceReviewReason(o,'Commande modifiée sur la plateforme'),null);});
