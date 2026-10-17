import test from 'node:test';import assert from 'node:assert/strict';import {prepareIncompleteTemuCatalogue,sourceCatalogueBlock} from '../src/temu-source-catalogue.mjs';
function fixture(option={}){
 const now=Date.now(),reference='PO-050-TEST',sourceSku='SKU',source={visibilityHold:true,mallId:'M'},order={id:'O',reference,channel:'temu',archived:false,partial_mode:false,resolution_pending_resume:true,label_status:'blocked',tracking_status:'unknown',suspension:{},source_payload:source,erp_live:{},issue:'TEMU refuse l’opération : 180020006 The current order status cannot be viewed.'};
 const observation={reference,sourceVersion:Math.floor(now/1000),checkedAt:new Date(now).toISOString(),sourceStage:'fulfillment',coverage:{detail:true,version:true,consistency:true,shipping:true,amounts:false},errors:[{field:'amounts',code:'3000032'}],payload:{detail:{parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,parentOrderTime:Math.floor(now/1000)-60,updateTime:Math.floor(now/1000)},orderList:[{orderSn:'L',quantity:5,goodsName:'Nom local',originalGoodsName:'Nom source',productList:[{extCode:sourceSku}]}]}}};
 const settings={automatic_live:{enabled:true},marketplace_automatic:{enabled:true,channels:{temu:true},since:new Date(now-86400000).toISOString()}},mapping={target_sku:option.converted?'TARGET':sourceSku,source_qty:'1',target_qty:'1'};
 if(option.childCancelled)observation.payload.detail.orderList[0].orderStatus=3;
 if(option.zeroLines)observation.payload.detail.orderList[0].quantity=0;
 if(option.paused)settings.automatic_live.enabled=false;if(option.old)settings.marketplace_automatic.since=new Date(now).toISOString();if(option.stock)order.issue='Stock insuffisant';if(option.archived)order.archived=true;if(option.suspended)order.suspension={active:true};if(option.cancelled){observation.sourceStage='cancelled';observation.payload.detail.parentOrderMap.parentOrderStatus=3;}if(option.uncertain)source.temuDirect={attemptedAt:new Date(now).toISOString()};if(option.nameMissing){observation.payload.detail.orderList[0].goodsName='';observation.payload.detail.orderList[0].originalGoodsName='';}if(option.stale)observation.checkedAt=new Date(now-3600000).toISOString();if(option.buyerCancel)observation.payload.detail.parentOrderMap.parentOrderLabel=[{name:'pending_buyer_cancellation',value:1}];
 if(option.ratio!==undefined)mapping.target_qty=option.ratio;
 const journal=new Map(),reviews=[],mutations=[],bindings=[];let present=!!option.existing,guardReads=0;
 if(option.previousAttempt)journal.set(mapping.target_sku,{status:'attempted',product_id:null});
 const variant=()=>({id:'V',sku:mapping.target_sku,active:true,variant_prices:[],product:{id:'P',active:true,label:'Nom source'}});
 const db={exec:async()=>{},query:async(sql,args=[])=>{
  if(sql.includes('to_regclass'))return {rows:[{present:true}]};if(sql.startsWith('SELECT key,value'))return {rows:Object.entries(settings).map(([key,value])=>({key,value}))};
  if(sql.startsWith('SELECT o.*,q.observation'))return {rows:[{...order,catalogue_observation:observation}]};
  if(sql.startsWith('SELECT * FROM orders')){guardReads++;if(option.change&&guardReads===2)order.issue='Stock insuffisant';return {rows:[structuredClone(order)]};}
  if(sql.startsWith('SELECT observation'))return {rows:[{observation}]};if(sql.startsWith('SELECT target_sku'))return {rows:[mapping]};
  if(sql.startsWith('SELECT EXISTS'))return {rows:[{protected:!!option.documents}]};
  if(sql.startsWith('SELECT live_variant_id'))return {rows:option.linked?[{live_variant_id:'OTHER'}]:[]};
  if(sql.startsWith('SELECT status,product_id'))return {rows:journal.has(args[0])?[journal.get(args[0])]:[]};
  if(sql.startsWith('INSERT INTO erplain_product_creation_attempts')){if(journal.has(args[0]))return {rows:[]};journal.set(args[0],{status:'attempted'});return {rows:[{sku:args[0]}]};}
  if(sql.startsWith('UPDATE erplain_product_creation_attempts')){const j=journal.get(args[0]);if(sql.includes('product_id=$2'))j.product_id=args[1];if(sql.includes("status='verified'"))j.status='verified';if(sql.includes("status='review'"))j.status='review';return {rows:[]};}
  if(sql.startsWith('INSERT INTO erplain_product_creation_reviews')){reviews.push(args);return {rows:[]};}if(sql.startsWith('INSERT INTO audit'))return {rows:[]};throw Error('SQL non prevu '+sql.slice(0,70));
 }};
 const api={verify:async()=>({id:100174}),request:async(query,variables)=>{if(query.startsWith('query '))return {Variants:{data:present?[variant()]:[],paginatorInfo:{hasMorePages:false}}};assert.equal(query.startsWith('mutation V3MissingProductCreate'),true);mutations.push(variables);present=true;return {CreateProduct:{id:'P'}};}};
 return {db,api,order,observation,settings,now,reviews,mutations,bindings,options:{now:()=>now,withLock:fn=>fn(),bind:async v=>bindings.push(v)}};
}
test('SKU and verified name prepare catalogue without amounts, prices, stock or order writes',async()=>{const f=fixture(),before=JSON.stringify(f.order);const r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(r.report[0].status,'created');assert.equal(f.mutations.length,1);assert.deepEqual(f.mutations[0].input,{label:'Nom source',active:true,variants:{data:[{type:'normal',sku:'SKU',track_inventory:true}]}});assert.equal(JSON.stringify(f.order),before);assert.equal(f.bindings.length,1);await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(f.mutations.length,1);});
for(const reason of ['paused','old','stock','archived','suspended','uncertain','nameMissing','stale','previousAttempt','documents','converted','change','zeroLines','linked'])test('catalogue independent preserves '+reason,async()=>{const f=fixture({[reason]:true}),before=JSON.stringify(f.order);const r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(f.mutations.length,0);if(reason!=='paused')assert.equal(r.report[0].status,'review');if(reason!=='change')assert.equal(JSON.stringify(f.order),before);});

for(const status of [1,2,3,4,5,6,7])test('catalogue respects cancelled source while other platform statuses remain indicative: '+status,async()=>{
 const f=fixture();f.observation.payload.detail.parentOrderMap.parentOrderStatus=status;
 f.observation.sourceStage=status===3?'cancelled':status===1?'pending':'fulfillment';
 const line=f.observation.payload.detail.orderList[0];line.orderStatus=status;line.isCancelledDuringPending=true;line.canceledQuantityBeforeShipment=line.quantity;
 f.observation.payload.detail.parentOrderMap.parentOrderLabel=[{name:'pending_buyer_cancellation',value:1}];
 const before=JSON.stringify(f.order),r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);
 assert.equal(r.report[0].status,status===3?'review':'created');assert.equal(f.mutations.length,status===3?0:1);assert.equal(JSON.stringify(f.order),before);
});
test('existing converted SKU is reread and never recreated',async()=>{const f=fixture({converted:true,existing:true});const r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(r.report[0].status,'existing');assert.equal(f.mutations.length,0);assert.equal(f.bindings.length,1);});

for(const ratio of [2,10,30,60,'30'])test('same SKU quantity conversion does not require confirming the product name: '+ratio,async()=>{const f=fixture({ratio}),before=JSON.stringify(f.order);const r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(r.report[0].status,'created');assert.equal(f.mutations.length,1);assert.equal(f.mutations[0].input.label,'Nom source');assert.equal(f.mutations[0].input.variants.data[0].sku,'SKU');assert.equal(JSON.stringify(f.order),before);await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(f.mutations.length,1);});
for(const ratio of [0,-1,null,'',false,'bad'])test('invalid quantity conversion never creates a product: '+String(ratio),async()=>{const f=fixture({ratio});const r=await prepareIncompleteTemuCatalogue(f.db,f.api,f.options);assert.equal(r.report[0].status,'review');assert.equal(f.mutations.length,0);assert.match(r.report[0].error,/Conversion de quantité invalide/);});
test('source identity and required current proof are never inferred',()=>{const f=fixture();assert.ok(sourceCatalogueBlock(null,f.observation,f.settings,f.now));assert.ok(sourceCatalogueBlock(f.order,{...f.observation,reference:'OTHER'},f.settings,f.now));assert.ok(sourceCatalogueBlock(f.order,{...f.observation,coverage:{...f.observation.coverage,consistency:false}},f.settings,f.now));});
