import {pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectProblemOrders,paginateProblemOrders,WITHOUT_DIAGNOSTIC} from '../src/problem-typology.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {orderQuery} from '../src/order-query.mjs';

test('exact labels, distinct order counts, OR and filtering before pagination',()=>{
 const orders=Array.from({length:125},(_,i)=>({id:String(i),diagnostics:i%3===0?['A','B','A']:['B']}));
 const classify=o=>o.diagnostics.map(label=>({label}));
 const result=selectProblemOrders(orders,['A'],classify);
 assert.equal(result.total,42);assert.equal(result.problemTypes.find(t=>t.label==='A').count,42);
 assert.deepEqual(paginateProblemOrders(result,2,10).rows.map(o=>o.id),orders.filter(o=>o.diagnostics.includes('A')).slice(10,20).map(o=>o.id));
 assert.equal(selectProblemOrders(orders,['A','B'],classify).total,125);
 assert.equal(selectProblemOrders(orders,[],classify).total,125);
 assert.equal(selectProblemOrders(orders,['C'],classify).total,0);
 assert.throws(()=>paginateProblemOrders(result,1,0));
});
test('missing detailed diagnostic only for rows in problem scope',()=>{
 const result=selectProblemOrders([{id:'blocked'},{id:'normal'}],[WITHOUT_DIAGNOSTIC],()=>[],['blocked']);
 assert.deepEqual(result.rows.map(o=>o.id),['blocked']);assert.equal(result.problemTypes[0].count,1);
});
test('served diagnostic classifier supplies distinct platform and weight labels',()=>{
 const classify=currentProblemClassifier();
 const orders=[{id:'1',issue:'Commande déjà expédiée sur la plateforme'},{id:'2',issue:'Commande modifiée sur la plateforme'},{id:'3',issue:'Unité de poids invalide'},{id:'4',label_status:'blocked'}];
 const before=JSON.stringify(orders);
 assert.deepEqual(selectProblemOrders(orders,['Commande déjà expédiée sur la plateforme'],classify).rows.map(o=>o.id),['1']);
 assert.deepEqual(selectProblemOrders(orders,['Unité de poids invalide'],classify).rows.map(o=>o.id),['3']);
 assert.ok(selectProblemOrders(orders,[],classify).problemTypes.some(t=>t.label==='Blocage sans motif enregistré'));
 assert.equal(JSON.stringify(orders),before);
});
test('statistics scope uses bound exact IDs, including empty results',()=>{
 const params=new URLSearchParams('channel=temu&search=test&direction=asc');
 const all=orderQuery(params),subset=orderQuery(params,['first',"x' OR true"]);
 assert.ok(subset.where.includes('orders.id=ANY('));assert.deepEqual(subset.args[0],['first',"x' OR true"]);assert.equal(subset.order,all.order);
 assert.deepEqual(orderQuery(params,[]).args[0],[]);
});

const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
const start=server.indexOf("    if((p==='/api/orders'||p==='/api/order-problem-types')");
const end=server.indexOf("    if(p==='/api/products'",start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const execute=new AsyncFunction('p','req','url','db','orderQuery','managerSql','partialAllocationSql','orderPageDetails','projectCurrentDiagnostics','readerJobs','catalog','selectProblemOrders','paginateProblemOrders','currentProblemClassifier','orderStatistics','cachedOrderSummary','json','res','readOrdersPage',server.slice(start,end));
const readerSource=readFileSync(new URL('../src/order-list-reader.mjs',import.meta.url),'utf8');
const readerBody=readerSource.slice(readerSource.indexOf('export async function readOrdersPage')+'export '.length);
async function route(path,query,{all=false}={}){
 const rows=Array.from({length:120},(_,i)=>({id:String(i),issue:i>=100?'Commande déjà expédiée sur la plateforme':'',label_status:'pending',source_payload:{},sku_lines:[]}));
 let out,sql,statsIds;
 const db={query:async(q,args)=>{if(q.startsWith('SELECT id FROM orders'))return {rows:rows.filter(o=>o.issue).map(o=>({id:o.id}))};sql={q,args};return {rows:structuredClone(rows)};}};
 db.readTransaction=read=>read(db);
 const statistics=async(_db,_params,ids)=>{statsIds=ids;return {transportStats:[],summary:{total:ids.length}};},cached=async()=>({transportStats:[],summary:{total:120}});
 const dependencies={orderQuery,managerSql:'NULL',partialAllocationSql:'NULL',orderPageDetails:async()=>{},projectCurrentDiagnostics:o=>o,selectProblemOrders,paginateProblemOrders,currentProblemClassifier,orderStatistics:statistics};
 const reader=new Function(...Object.keys(dependencies),readerBody+';return readOrdersPage;')(...Object.values(dependencies));
 await execute(path,{method:'GET'},new URL('https://example.test'+path+'?'+query),db,orderQuery,'NULL','NULL',async()=>{},o=>o,{snapshot:async()=>({configured:true})},{status:()=>({})},selectProblemOrders,paginateProblemOrders,currentProblemClassifier,statistics,cached,(_res,status,data)=>{assert.equal(status,200);out=data;},{},(db,options)=>reader(db,{...options,all}));
 return {out,sql,statsIds};
}
test('shared export reader retains every filtered order beyond the displayed page',async()=>{
 const query='problem-label=Commande+d%C3%A9j%C3%A0+exp%C3%A9di%C3%A9e+sur+la+plateforme&page=2&pageSize=50';
 const displayed=await route('/api/orders',query),exported=await route('/api/orders',query,{all:true});assert.equal(displayed.out.rows.length,0);assert.equal(exported.out.rows.length,20);assert.equal(exported.out.total,displayed.out.total);assert.deepEqual(exported.statsIds,displayed.statsIds);
});
test('integrated GET filters all pages and restricts statistics to same orders',async()=>{
 const {out,sql,statsIds}=await route('/api/orders','problem-label=Commande+d%C3%A9j%C3%A0+exp%C3%A9di%C3%A9e+sur+la+plateforme&page=2&pageSize=50');
 assert.equal(out.total,20);assert.equal(out.rows.length,0);assert.equal(statsIds.length,20);assert.equal(sql.args.length,0);assert.ok(!sql.q.includes('LIMIT 50'));
 const first=await route('/api/orders','problem-label=Commande+d%C3%A9j%C3%A0+exp%C3%A9di%C3%A9e+sur+la+plateforme');
 assert.equal(first.out.rows[0].id,'100');assert.equal(first.out.rows.length,20);
});
test('integrated catalogue returns current labels and counts across the entire scope',async()=>{
 const {out}=await route('/api/order-problem-types','page=3');
 assert.equal(out.problemTypes.find(t=>t.label==='Commande déjà expédiée sur la plateforme').count,20);
 assert.equal(out.rows,undefined);
});
test('ordinary list retains SQL pagination and existing statistics',async()=>{
 const {out,sql,statsIds}=await route('/api/orders','page=2');
 assert.ok(sql.q.includes('LIMIT 50'));assert.equal(sql.args.at(-1),50);assert.equal(out.total,120);assert.equal(statsIds,undefined);
});
test('cancelled and archived orders never contribute stale errors or fallback labels to problem counts',()=>{
 const classify=currentProblemClassifier(),reason='Commande modifiée sur la plateforme';
 const inactive=[{id:'cancelled',label_status:'cancelled'},{id:'tracking',tracking_status:'cancelled'},{id:'archive',archived:true}].map(o=>({...o,issue:reason,resolution_error:reason,erp_error:'Ancien échec',lines:[]}));
 for(const o of inactive)assert.equal(classify(o).length,0);
 const result=selectProblemOrders([...inactive,{id:'active',issue:reason}],['Commande modifiée sur la plateforme'],classify,inactive.map(o=>o.id));
 assert.equal(result.total,1);assert.equal(result.problemTypes.length,1);assert.equal(result.problemTypes[0].count,1);
 assert.equal(selectProblemOrders(inactive,[WITHOUT_DIAGNOSTIC],classify,inactive.map(o=>o.id)).total,0);
 const query=orderQuery(new URLSearchParams({status:'__problems'}));assert.match(query.where,/label_status IS DISTINCT FROM 'cancelled'/);assert.match(query.where,/tracking_status IS DISTINCT FROM 'cancelled'/);
});

// Human display rule: documents are preserved; no business state is completed here.
test('BC, BL and existing label retire blocking badges across every channel',()=>{
 const classify=currentProblemClassifier();
 for(const channel of ['temu','shopify','amazon','tender','samples'])for(const partial of [false,true])for(const temu of [false,true]){
  const o={channel,erp_live:{bc:{id:1},bl:partial?null:{id:2}},erplain_tracking_bls:partial?[{id:3}]:[],document_count:temu?0:1,temu_documents:temu?[{package:'p'}]:[],issue:'Stock insuffisant',label_status:'blocked',erp_status:'live_review',erp_live_job:{status:'review',error:'HTTP 500'},carrier_job:{status:'failed',error:'HTTP 500'},resolution_error:'Intervention interrompue'};
  const before=JSON.stringify(o);assert.equal(classify(o).length,0);assert.equal(JSON.stringify(o),before);
  for(const missing of ['bc','bl','label']){const n=structuredClone(o);if(missing==='bc')n.erp_live.bc=null;if(missing==='bl'){n.erp_live.bl=null;n.erplain_tracking_bls=[];}if(missing==='label'){n.document_count=0;n.temu_documents=[];}assert.ok(classify(n).length>0);}
 }
});

test('complete documents do not receive the missing-diagnostic fallback in problem filters',()=>{
 const o={id:'complete',erp_live:{bc:{id:1},bl:{id:2}},document_count:1,label_status:'blocked',issue:'Stock insuffisant'};
 const r=selectProblemOrders([o],[WITHOUT_DIAGNOSTIC],currentProblemClassifier(),['complete']);
 assert.equal(r.total,0);assert.equal(r.problemTypes.length,0);
});

test('missing BL validation is not a stock shortage, including stored legacy override advice',()=>{
 const classify=currentProblemClassifier();
 const gate='Étiquette bloquée : contrôle du stock et BL validé requis.';
 for(const message of [gate,gate+' En cas de stock insuffisant, utiliser le bouton dédié de dérogation.']){
  const orders=Array.from({length:44},(_,i)=>({id:String(i),channel:'temu',erp_live:{},temu_job:{status:'to_buy',error:message}}));
  const result=selectProblemOrders(orders,[],classify);
  assert.equal(result.problemTypes.some(p=>p.label==='Bloqué : stock insuffisant'),false);
  assert.equal(result.problemTypes.find(p=>p.label==='Validation stock / BL à effectuer').count,44);
 }
 const actual=classify({id:'shortage',channel:'temu',erp_live_job:{status:'review',error:'BL bloqué — stock insuffisant : SKU : 1 nécessaires, 0 utilisables, manque 1'}});
 assert.ok(actual.some(p=>p.type==='stock'&&p.label==='Bloqué : stock insuffisant'));
});

test('suspension and cancelled BC retire all problem labels and fallback without changing data',()=>{
 const classify=currentProblemClassifier(),reason='BC · Statut modifié : contrôler avant reprise';
 const inactive=[{id:'suspended',suspension:{active:true,note:'Attente client'}},{id:'cancelled-bc',erp_live:{bc:{id:1926983,status:'cancelled'}}},{id:'confirmed-cancellation',suspension:{erplainCancellation:{status:'complete'}}}].map(o=>({...o,label_status:'simulated',tracking_status:'not_shipped',issue:reason,resolution_error:reason,lines:[]}));
 for(const o of inactive){const before=JSON.stringify(o);assert.equal(classify(o).length,0);assert.equal(JSON.stringify(o),before);}
 const active={id:'active',label_status:'simulated',issue:reason,lines:[]};
 const selected=selectProblemOrders([...inactive,active],['BC · Statut modifié : contrôler avant reprise'],()=>[{label:'BC · Statut modifié : contrôler avant reprise'}],inactive.map(o=>o.id));
 assert.deepEqual(selected.rows.map(o=>o.id),['active']);assert.equal(selected.problemTypes[0].count,1);
 assert.equal(selectProblemOrders(inactive,[WITHOUT_DIAGNOSTIC],()=>[],inactive.map(o=>o.id)).total,0);
 // A single cancelled partial BL must not hide a still-active order/remainder.
 const partial={id:'partial',erp_live:{bc:{status:'active'},bl:{status:'cancelled'}},label_status:'blocked',issue:'Stock insuffisant',lines:[]};assert.ok(classify(partial).length>0);
});

test('deferred problems keep their real diagnostics but disappear from active counts and fallback',()=>{
 const o={id:'deferred',suspension:{problemDeferral:{active:true}},label_status:'blocked',issue:'Stock insuffisant',lines:[]};
 const before=JSON.stringify(o);assert.ok(currentProblemClassifier()(o).length>0);
 assert.equal(selectProblemOrders([o],['Bloqué : stock insuffisant'],currentProblemClassifier(),['deferred']).total,0);
 assert.equal(selectProblemOrders([o],[WITHOUT_DIAGNOSTIC],()=>[],['deferred']).total,0);
 assert.equal(JSON.stringify(o),before);
});

test('active problem gate executes before pagination and cannot be bypassed by combined status filters',async()=>{
 const {activeProblemOrderSql}=await import('../src/order-query.mjs');
 const {PGlite}=await (process.env.PGLITE_MODULE?import(pathToFileURL(process.env.PGLITE_MODULE).href):import('@electric-sql/pglite'));
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,archived boolean DEFAULT false,suspension jsonb DEFAULT '{}',label_status text DEFAULT 'simulated',tracking_status text DEFAULT 'not_shipped',erp_live jsonb DEFAULT '{}');`);
  const fixtures=[['active',{},{}],['suspended',{active:true},{}],['cancelled-bc',{}, {bc:{status:'cancelled'}}],['confirmed',{erplainCancellation:{status:'complete'}},{}],['review',{erplainCancellation:{status:'review'}},{}],['reactivated',{active:false},{}],['partial',{}, {bc:{status:'active'},bl:{status:'cancelled'}}]];
  for(const [id,s,erp]of fixtures)await db.query('INSERT INTO orders(id,suspension,erp_live) VALUES($1,$2,$3)',[id,JSON.stringify(s),JSON.stringify(erp)]);
  await db.exec("INSERT INTO orders(id,label_status) VALUES('cancelled-label','cancelled');INSERT INTO orders(id,tracking_status) VALUES('cancelled-tracking','cancelled');INSERT INTO orders(id,archived) VALUES('archived',true)");
  const rows=(await db.query('SELECT id FROM orders WHERE '+activeProblemOrderSql+' ORDER BY id')).rows.map(o=>o.id);assert.deepEqual(rows,['active','partial','reactivated','review']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders WHERE '+activeProblemOrderSql)).rows[0].n,4);
  assert.deepEqual((await db.query('SELECT id FROM orders WHERE '+activeProblemOrderSql+' ORDER BY id LIMIT 2 OFFSET 2')).rows.map(o=>o.id),['reactivated','review']);
  for(const params of ['status=__problems','status=__problems,__suspended','problem=stock','problem-label=Stock'])assert.ok(orderQuery(new URLSearchParams(params)).where.includes(activeProblemOrderSql));
  for(const params of ['', 'status=__suspended','search=cancelled-bc'])assert.ok(!orderQuery(new URLSearchParams(params)).where.includes(activeProblemOrderSql));
 }finally{await db.close();}
});


test('active problem status uses current diagnostics before pagination, totals and XLSX export',async()=>{
 const first=await route('/api/orders','status=__problems');
 assert.equal(first.out.total,20);assert.equal(first.out.rows.length,20);assert.equal(first.statsIds.length,20);assert.ok(!first.sql.q.includes('LIMIT 50'));
 const second=await route('/api/orders','status=__problems&page=2');assert.equal(second.out.total,20);assert.equal(second.out.rows.length,0);
 const exported=await route('/api/orders','status=__problems&page=2',{all:true});assert.equal(exported.out.total,20);assert.equal(exported.out.rows.length,20);
});
