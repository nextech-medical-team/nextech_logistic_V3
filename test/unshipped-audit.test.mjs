import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {auditOptions,auditAge,includeAuditRow,parseAmazonAuditReport,matchAuditOrders,diagnoseAuditRow,auditView} from '../src/unshipped-audit-core.mjs';
import {initializeUnshippedAudit,unshippedAuditService,unshippedAuditRoutes} from '../src/unshipped-audit.mjs';

const now=()=>new Date('2026-11-05T12:00:00Z'),user={email:'test@example.invalid'},ref='PO-069-1234567890';
const amazonInput=(text,filename='commandes.txt')=>({filename,content:Buffer.from(text).toString('base64'),reportedAt:'2026-11-04T12:00:00Z'});
const reportText='order-id\tpurchase-date\torder-status\tsku\tquantity-unshipped\n123-1234567-1234567\t2026-10-20T08:00:00Z\tUnshipped\tA\t2';
async function database(){
 const pg=new PGlite(),locks=new Map();
 const db={query:(...a)=>pg.query(...a),exec:q=>pg.exec(q),transaction:fn=>pg.transaction(tx=>fn({query:(...a)=>tx.query(...a),exec:q=>tx.exec(q)})),async withLocks(keys,fn){const k=keys.join(','),prior=locks.get(k)||Promise.resolve();let release;const next=new Promise(r=>release=r);locks.set(k,next);await prior;try{return await fn();}finally{release();if(locks.get(k)===next)locks.delete(k);}},close:()=>pg.close()};
 await db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,channel TEXT,reference TEXT,source_reference TEXT,source_payload JSONB DEFAULT '{}',erp_live JSONB DEFAULT '{}',archived BOOLEAN DEFAULT false,issue TEXT,suspension JSONB DEFAULT '{}',label_status TEXT DEFAULT 'pending',tracking_status TEXT DEFAULT 'unknown');
 CREATE TABLE erp_live_jobs(order_id TEXT,status TEXT,error TEXT);
 CREATE TABLE carrier_jobs(order_id TEXT,carrier TEXT,status TEXT,tracking JSONB,error TEXT,environment TEXT);
 CREATE TABLE partial_deliveries(order_id TEXT,carrier TEXT,status TEXT,tracking JSONB,error TEXT,environment TEXT);
 CREATE TABLE extra_parcels(order_id TEXT,carrier TEXT,status TEXT,tracking TEXT,environment TEXT);
 CREATE TABLE resolution_jobs(id TEXT,order_id TEXT,status TEXT,stage TEXT,error TEXT,created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE carrier_tracking(carrier TEXT,tracking TEXT,environment TEXT,checked_at TIMESTAMPTZ,events JSONB,error TEXT);`);
 await initializeUnshippedAudit(db);return db;
}
const sourceOrder=(reference=ref,date='2026-10-20T08:00:00Z')=>({parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,parentOrderTime:Date.parse(date)/1000,expectShipLatestTime:Date.parse('2026-10-22T12:00:00Z')/1000}});
function readers({temuRows=[sourceOrder()],shopify=[],bcs=[],tracking=async()=>[],page}={}){
 return ()=>({
  temu:async()=>({sources:[{mall:'mall-a',country:'FR',page:page||(async()=>({pageItems:temuRows,totalItemNum:temuRows.length})),details:async reference=>({reference,status:2,packages:[],errors:[]})}],errors:[]}),
  shopify:{read:async()=>({shop:'test.myshopify.com',data:{orders:{nodes:shopify,pageInfo:{hasNextPage:false}}}})},
  erp:{verify:async()=>({id:100174}),request:async(query,{where})=>{assert.match(query,/^query /);const field=query.includes('{ShippingOrders(')?'ShippingOrders':'Orders',refs=where.OR.map(o=>o.value);return {[field]:{data:field==='Orders'?bcs.filter(b=>refs.includes(b.external_reference)):[],paginatorInfo:{hasMorePages:false}}};}},tracking:{read:tracking}
 });
}
async function businessSnapshot(db){const result={};for(const t of ['orders','erp_live_jobs','carrier_jobs','partial_deliveries','extra_parcels','resolution_jobs','carrier_tracking'])result[t]=(await db.query('SELECT * FROM '+t)).rows;return result;}
test('ancienneté configurable, borne exacte et dates inconnues visibles',()=>{
 assert.equal(auditOptions().minAgeDays,3);assert.throws(()=>auditOptions({minAgeDays:0}),/Ancienneté/);assert.throws(()=>auditOptions({channels:['amazon']}),/rapport Amazon/);
 assert.equal(auditAge('2026-11-02T12:00:00Z',now().toISOString()),3);
 assert.equal(includeAuditRow({date:'2026-11-02T12:00:01Z'},auditOptions(),now().toISOString()),false);
 assert.equal(includeAuditRow({date:null},auditOptions(),now().toISOString()),true);
 assert.equal(auditAge('2027-01-01',now().toISOString()),null);
});
test('Amazon : regroupement, quantités restantes et exclusion des lignes déjà expédiées',async()=>{
 const text=reportText+'\n123-1234567-1234567\t2026-10-20T08:00:00Z\tPartiallyShipped\tB\t1\n123-0000000-0000001\t2026-10-20T08:00:00Z\tShipped\tC\t1\n123-0000000-0000002\t2026-10-20T08:00:00Z\tUnshipped\tD\t0';
 const parsed=await parseAmazonAuditReport(amazonInput(text),now());assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].lines.length,2);assert.equal(parsed.excluded,2);assert.equal(parsed.rows[0].sourceAt,'2026-11-04T12:00:00.000Z');
 const noStatus=await parseAmazonAuditReport(amazonInput('order-id\tpurchase-date\n123-1234567-1234567\t2026-10-20'),now());assert.equal(noStatus.rows[0].sourceStatus,'Non expédié selon le rapport');
 await assert.rejects(parseAmazonAuditReport(amazonInput('ref\tdate\nX\t2026-10-20'),now()),/Colonnes/);
 const bad=await parseAmazonAuditReport(amazonInput('order-id\tpurchase-date\n123-1234567-1234567\t20 mars'),now());assert.equal(bad.rows[0].date,null);assert.ok(bad.rows[0].errors.length);
 const invalidDay=await parseAmazonAuditReport(amazonInput('order-id\tpurchase-date\n123-1234567-1234567\t2026-02-31'),now());assert.equal(invalidDay.rows[0].date,null);
 const partial=await parseAmazonAuditReport(amazonInput('order-id\tpurchase-date\torder-status\n123-1234567-1234567\t2026-10-20\tPartiallyShipped'),now());assert.match(partial.rows[0].errors.join(' '),/quantités restantes/);
 await assert.rejects(parseAmazonAuditReport({...amazonInput(reportText),reportedAt:'2030-01-01'},now()),/Date du rapport/);
});
test('rapprochement par canal, référence et boutique ; pas de faux doublon inter-boutiques',()=>{
 const row={channel:'temu',reference:ref,shop:'mall-a'},o={id:'one',channel:'temu',reference:ref+'/',source_payload:{mallId:'mall-b'}};
 assert.equal(matchAuditOrders(row,[o]).length,0);assert.equal(matchAuditOrders(row,[{...o,source_payload:{mallId:'mall-a'}}]).length,1);
 assert.equal(matchAuditOrders(row,[{...o,channel:'amazon',source_payload:{mallId:'mall-a'}}]).length,0);
 assert.equal(diagnoseAuditRow({v3:[{}],bc:[{status:'cancelled'},{status:'active'}],bl:[],parcels:[]}), 'BC existant ; BL à vérifier');
 assert.equal(diagnoseAuditRow({v3:[{}],labelAvailable:true,parcels:[]}), 'Étiquette disponible ; suivi non confirmé');
});
test('contrôle API multi-sources persistant ; aucun import ni mutation métier',async()=>{
 const db=await database();try{
  await db.query("INSERT INTO orders(id,channel,reference,source_payload,erp_live) VALUES('one','temu',$1,$2,$3)",[ref,JSON.stringify({mallId:'mall-a'}),JSON.stringify({bc:{id:1,label:'C1'},bl:{id:2,label:'SHO1',status:'ready_to_ship'}})]);
  await db.query("INSERT INTO erp_live_jobs VALUES('one','complete',NULL)");
  const before=await businessSnapshot(db),factory=readers({temuRows:[sourceOrder(),sourceOrder('PO-069-9999999999','2026-11-04T13:00:00Z')],shopify:[{id:'gid://shopify/Order/1',name:'#100',createdAt:'2026-10-01T12:00:00Z',cancelledAt:null,displayFulfillmentStatus:'PARTIALLY_FULFILLED',fulfillments:[]}],bcs:[{id:7,label:'C7',status:'active',external_reference:'#100',shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}]}),service=unshippedAuditService(db,'/unused',{now,workerAvailable:async()=>true,sourceFactory:factory});
  const report=await service.upload(amazonInput(reportText),user),again=await service.upload(amazonInput(reportText),user);assert.equal(report.id,again.id);assert.equal((await service.reports()).length,1);
  const [a,b]=await Promise.all([service.start({channels:['temu','shopify','amazon'],amazonReportId:report.id},user),service.start({channels:['temu']},user)]);assert.equal(a.id,b.id);assert.equal(b.existing,true);
  await service.run();const s=await service.read(a.id);assert.equal(s.status,'complete');assert.equal(s.rows.length,3);assert.equal(s.sourceCounts.temu,2);assert.equal(s.rows.find(r=>r.reference===ref).v3.length,1);
  const absent=s.rows.find(r=>r.reference==='#100');assert.equal(absent.diagnosis,'Absente de V3 ; BC Erplain retrouvé');assert.equal(s.rows.find(r=>r.channel==='amazon').sourceKind,'Rapport Amazon');
  assert.deepEqual(await businessSnapshot(db),before);assert.equal((await service.history()).length,1);
  const view=auditView(s,{channel:'amazon',search:'123-',page:999});assert.equal(view.total,1);assert.equal(view.page,1);
 }finally{await db.close();}
});
test('GOFO 429 : arrêt des appels, pause persistée et cache ancien jamais présenté comme suivi actuel',async()=>{
 const db=await database();try{
  await db.query("INSERT INTO orders(id,channel,reference,source_payload) VALUES('one','temu',$1,$2)",[ref,JSON.stringify({mallId:'mall-a'})]);
  await db.query("INSERT INTO carrier_jobs VALUES('one','gofo','ready',$1,NULL,'production')",[JSON.stringify(['GFFR000001','GFFR000002'])]);
  const old=[{carrier:'gofo',tracking:'GFFR000001',code:'205',label:'Delivered',at:'2026-10-20T12:00:00Z'}];await db.query("INSERT INTO carrier_tracking VALUES('gofo','GFFR000001','production','2026-10-21',$1,NULL)",[JSON.stringify(old)]);
  const before=await businessSnapshot(db);let calls=0;const factory=readers({tracking:async()=>{calls++;throw Object.assign(Error('API suivi · HTTP 429'),{retryAfter:7200});}}),service=unshippedAuditService(db,'/unused',{now,workerAvailable:async()=>true,sourceFactory:factory});
  const job=await service.start({channels:['temu']},user);await service.run();const s=await service.read(job.id);assert.equal(calls,1);assert.equal(s.status,'partial');assert.equal(s.rows[0].parcels[0].lastKnown.status,'delivered');assert.equal(s.rows[0].parcels[0].observation,'unavailable');assert.doesNotMatch(s.rows[0].diagnosis,/Livraison observée/);assert.equal((await db.query('SELECT * FROM unshipped_audit_cooldowns')).rows.length,1);assert.deepEqual(await businessSnapshot(db),before);
 }finally{await db.close();}
});
test('pagination TEMU incomplète : conserve les lignes et marque explicitement le contrôle partiel',async()=>{
 const db=await database();try{
  const rows=Array.from({length:50},(_,i)=>sourceOrder('PO-069-'+(1000000000+i))),factory=readers({page:async page=>({totalItemNum:51,pageItems:page===1?rows:[]})}),service=unshippedAuditService(db,'/unused',{now,workerAvailable:async()=>true,sourceFactory:factory});
  const job=await service.start({channels:['temu']},user);await service.run();const s=await service.read(job.id);assert.equal(s.rows.length,50);assert.equal(s.status,'partial');assert.equal(s.coverage[0].complete,false);assert.ok(s.errors.some(e=>/Total TEMU|Pagination/.test(e.message)));
 }finally{await db.close();}
});
test('redémarrage et worker indisponible : résultats conservés et pas de faux traitement lancé',async()=>{
 const db=await database();try{
  const s={id:'run',status:'running',rows:[{reference:'#1'}],options:{channels:['shopify'],minAgeDays:3}};await db.query('INSERT INTO unshipped_audit_runs VALUES($1,$2,$3,$4,now(),now())',['run','running','test',JSON.stringify(s)]);await initializeUnshippedAudit(db,{recover:true});
  const service=unshippedAuditService(db,'/unused',{now,workerAvailable:async()=>false});assert.equal((await service.read('run')).status,'interrupted');assert.equal((await service.read('run')).rows.length,1);await assert.rejects(service.start({channels:['shopify']},user),/indisponible/);
 }finally{await db.close();}
});
test('droits des routes et export CSV filtré, horodaté et protégé des formules',async()=>{
 const snapshot={id:'run',status:'complete',startedAt:now().toISOString(),rows:[{reference:'=1+1',channel:'shopify',shop:'test',sourceKind:'API Shopify',sourceAt:now().toISOString(),date:'2026-10-20',ageDays:16,v3:[],bc:[],bl:[],parcels:[],errors:[],diagnosis:'Absente de V3'}]},service={read:async()=>snapshot,start:async()=>{throw Error('Ne doit pas être appelé');},upload:async()=>{throw Error('Ne doit pas être appelé');}};
 const permitted=(u,roles)=>{if(!roles.includes(u.role))throw Error('Accès interdit');},res={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.value=v;}};
 for(const p of ['/api/unshipped-audit','/api/unshipped-audit/reports'])await assert.rejects(unshippedAuditRoutes({p,url:new URL('http://local'+p),req:{method:'POST'},res,service,user:{role:'viewer'},permitted,body:async()=>({}),json(){}}),/Accès interdit/);
 await unshippedAuditRoutes({p:'/api/unshipped-audit/export',url:new URL('http://local/api/unshipped-audit/export?channel=shopify'),req:{method:'GET'},res,service,user,permitted,json(){}});assert.match(res.headers['Content-Type'],/csv/);assert.match(res.value,/'=1\+1/);assert.match(res.value,/API Shopify/);assert.match(res.value,/2026-11-05/);
});

 test('missing shop identity never confirms V3 presence across shops',async()=>{
 const {matchAuditOrders,uncertainAuditOrders,diagnoseAuditRow}=await import('../src/unshipped-audit-core.mjs');
 for(const channel of ['shopify','temu']){
  const o={id:'legacy',channel,reference:'#100',source_payload:{}};
  for(const shop of ['shop-a','shop-b']){
   const row={channel,reference:'#100',shop};
   assert.equal(matchAuditOrders(row,[o]).length,0);
   assert.equal(uncertainAuditOrders(row,[o]).length,1);
   assert.match(diagnoseAuditRow({...row,v3:[],v3Uncertain:[o]}),/boutique V3 non confirmée/);
  }
 }
});
 test('uncertain legacy match cannot contribute parcels or blockers',async()=>{
 const db=await database();try{
  await db.query("INSERT INTO orders(id,channel,reference,issue) VALUES('legacy','temu',$1,'unrelated blocker')",[ref]);
  await db.query("INSERT INTO carrier_jobs VALUES('legacy','gofo','ready',$1,NULL,'production')",[JSON.stringify(['GFFR000001'])]);
  let trackingCalls=0;
  const service=unshippedAuditService(db,'/unused',{now,workerAvailable:async()=>true,sourceFactory:readers({tracking:async()=>{trackingCalls++;return [];}})});
  const job=await service.start({channels:['temu']},user);await service.run();const s=await service.read(job.id),row=s.rows[0];
  assert.equal(row.v3.length,0);assert.equal(row.v3Uncertain.length,1);assert.equal(row.parcels.length,0);assert.equal(trackingCalls,0);
  assert.equal(row.labelAvailable,undefined);assert.equal(s.status,'partial');assert.match(row.diagnosis,/boutique V3 non confirmée/);
 }finally{await db.close();}
});

test('CSV keeps uncertain shop identity distinct from absent V3 orders',async()=>{
 const snapshot={id:'run',status:'partial',startedAt:now().toISOString(),options:{minAgeDays:3},rows:[{channel:'shopify',reference:'#100',v3:[],v3Uncertain:[{id:'legacy'}],parcels:[],errors:[]}]};
 const res={setHeader(){},end(value){this.value=value;}};
 await unshippedAuditRoutes({p:'/api/unshipped-audit/export',url:new URL('http://local/api/unshipped-audit/export'),req:{method:'GET'},res,service:{read:async()=>snapshot},user,permitted(){},json(){}});
 assert.match(res.value,/Identité boutique non confirmée/);
});
