import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));
const live=JSON.parse((await fs.readFile(new URL('fixtures/bc-refresh/cases.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const dir=process.env.COMPARISON_SOURCE||path.join(root,'../src');
const {refreshErplainDocuments}=await import(pathToFileURL(path.join(dir,'erplain-documents-sync.mjs')));
const {reconcileRefreshedBcDiagnostics,physicalComparisonErrors}=await import(new URL('../src/bc-comparison-refresh.mjs',import.meta.url));
const clone=x=>structuredClone(x);
function fixture(entry){
 const state={order:clone(entry.order),lines:clone(entry.lines),jobs:clone(entry.jobs).map(j=>({...j,result:{kept:'original'}})),documents:[{pdf:'unchanged',tracking:'unchanged',annotation:'unchanged'}],erp:clone(entry.erp),busy:false};
 const writes=[];
 const db={state,writes,async query(sql,args=[]){
  if(sql.startsWith('SELECT source_sku,target_sku,quantity,target_quantity FROM lines'))return {rows:clone(state.lines).map(l=>({source_sku:l.source_sku,target_sku:l.target_sku,quantity:l.quantity,target_quantity:l.target_quantity}))};
  if(sql.startsWith('UPDATE orders SET issue=CASE WHEN $3')){writes.push(sql);if(args[2])state.order.issue=args[3];state.order.erp_live.stockIncidentRecheck=JSON.parse(args[1]);return {rows:[]}};
  if(sql.startsWith('SELECT id,action,status,error,result,created_at,updated_at FROM resolution_jobs'))return {rows:clone(state.jobs.filter(j=>j.status===(sql.includes("status='complete'")?'complete':'review')))};
  if(sql.startsWith('SELECT status,error FROM erp_live_jobs'))return {rows:state.erp?[clone(state.erp)]:[]};
  if(sql.startsWith('SELECT id FROM orders'))return {rows:[{id:state.order.id}]};
  if(sql.startsWith('SELECT * FROM partial_deliveries'))return {rows:[]};
  if(sql.startsWith('UPDATE orders SET erp_live=jsonb_set(jsonb_set')){writes.push(sql);state.order.erp_live={...state.order.erp_live,bc:JSON.parse(args[1]),partialSource:JSON.parse(args[2]),documentSource:JSON.parse(args[3])};return {rows:[]}};
  if(sql.startsWith('SELECT * FROM orders'))return {rows:[clone(state.order)]};
  if(sql.startsWith('SELECT 1 FROM erp_live_jobs'))return {rows:state.busy?[{busy:1}]:[]};
  if(sql.startsWith('SELECT id,error,result,action FROM resolution_jobs'))return {rows:clone(state.jobs.filter(j=>j.status==='review'))};
  if(sql.startsWith('SELECT l.*,m.target_sku'))return {rows:clone(state.lines)};
  if(sql.startsWith('UPDATE orders SET erp_live=$2')){writes.push(sql);state.order.erp_live=JSON.parse(args[1]);return {rows:[]}};
  if(sql.startsWith('UPDATE orders SET erp_live=jsonb_set')){writes.push(sql);state.order.erp_live.bcComparisonRefresh=JSON.parse(args[1]);return {rows:[]}};
  if(sql.startsWith('UPDATE resolution_jobs SET result=')){writes.push(sql);const j=state.jobs.find(j=>j.id===args[0]&&j.status==='review'&&j.error===args[4]);if(j){j.result={...(j.result&&typeof j.result==='object'&&!Array.isArray(j.result)?j.result:{previousResult:j.result}),...JSON.parse(args[2])};j.error=args[3]}return {rows:j?[{id:j.id}]:[]}};
  throw Error('SQL hors périmètre : '+sql);
 },async transaction(fn){const before=clone(state);try{return await fn(db)}catch(e){for(const k of Object.keys(state))delete state[k];Object.assign(state,before);throw e}}};
 const api={async verify(){},async request(q,v){assert.match(q,/^query\s/);assert.equal(String(v.id),String(entry.bc.id));return {Order:clone(entry.bc)}}};
 return {state,db,api};
}
const q=live.orders.find(x=>x.reference==='Q1936380');

for(const entry of live.orders)test('recorded BC fixture '+entry.reference+' preserves all documents and retires only source comparisons',async()=>{
 const {state,db}=fixture(entry),before=clone(state),r=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,entry.id,clone(entry.bc)));
 assert.equal(r.comparison.different,false);assert.equal(r.authority,'recorded_bc');
 assert.deepEqual(r.comparison.expected,r.comparison.observed);
 assert.deepEqual(state.lines,before.lines);assert.deepEqual(state.documents,before.documents);assert.deepEqual(state.erp,before.erp);
 for(const j of state.jobs){const old=before.jobs.find(x=>x.id===j.id);assert.equal(j.status,old.status);if(physicalComparisonErrors.includes(old.error)){assert.equal(j.error,null);assert.equal(j.result.bcComparisonRefresh.previousError,old.error);}else assert.equal(j.error,old.error);}
});
for(const channel of ['temu','amazon','shopify','tender','erplain'])for(const value of [true,false,'',[],{},null,0,-1,999])test(channel+' source quantity '+JSON.stringify(value)+' never gates recorded BC',async()=>{
 const {state,db}=fixture(q);state.order.channel=channel;state.lines[0].target_quantity=value;
 const before=clone(state.lines),r=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));
 assert.equal(r.concordant,true);assert.equal(r.authority,'recorded_bc');assert.deepEqual(state.lines,before);
});
test('independent mixed stock reason remains intact',async()=>{
 const {state,db}=fixture(q);state.jobs[0].error=physicalComparisonErrors[0]+' ; Stock insuffisant';const before=state.jobs[0].error;
 await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.equal(state.jobs[0].error,before);
});
for(const scenario of ['identité BC','pagination absente','pagination incomplète','ligne dupliquée','variante absente','traitement actif'])test(scenario+' : refus sans modification locale',async()=>{
 const {state,db}=fixture(q),bc=clone(q.bc);
 if(scenario==='identité BC')bc.id=999;
 if(scenario==='pagination absente')delete bc.shipping_orders.paginatorInfo;
 if(scenario==='pagination incomplète')bc.shipping_orders.paginatorInfo.hasMorePages=true;
 if(scenario==='ligne dupliquée')bc.line_items.push(clone(bc.line_items[0]));
 if(scenario==='variante absente')delete bc.line_items[0].variant.id;
 if(scenario==='traitement actif')state.busy=true;
 const before=clone(state);await assert.rejects(db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,bc)));assert.deepEqual(state,before);
});
for(const ref of ['PH2/00638941','2610813'])test('parcours partiel complet réel '+ref+' conserve les documents et la divergence justifiée',async()=>{
 const entry=live.orders.find(x=>x.reference===ref),{state,db,api}=fixture(entry),before=clone(state);
 const result=await refreshErplainDocuments(db,api,entry.id);
 assert.equal(result.comparison.concordant,true);assert.deepEqual(state.order.erp_live.bc.line_items,entry.bc.line_items);
 assert.deepEqual(state.lines,before.lines);assert.deepEqual(state.erp,before.erp);assert.deepEqual(state.documents,before.documents);assert.deepEqual(state.order.erp_live.pricing,before.order.erp_live.pricing);
 assert.equal(state.jobs[0].error,null);if(ref==='2610813')assert.equal(state.jobs[1].error,before.jobs[1].error);
});
for(const value of [true,false,'',' ',[],{},Infinity])test('réponse BC invalide '+JSON.stringify(value)+' : refus avant projection',async()=>{
 for(const entry of [q,live.orders[0]]){const {state,db,api}=fixture(entry),before=clone(state);api.request=async()=>{const bc=clone(entry.bc);bc.line_items[0].quantity=value;return {Order:bc}};await assert.rejects(refreshErplainDocuments(db,api,entry.id));assert.deepEqual(state,before)}
});
test('modification manuelle des quantités BC : afficher courant et garder écart',async()=>{
 const {state,db,api}=fixture(q);api.request=async()=>{const bc=clone(q.bc);bc.line_items[0].quantity=123;return {Order:bc}};
 const result=await refreshErplainDocuments(db,api,q.id);assert.equal(state.order.erp_live.bc.line_items[0].quantity,123);assert.equal(result.comparison.concordant,true);assert.equal(state.jobs[0].error,null);
});
test('identité locale modifiée pendant la requête : refus sans écrasement',async()=>{
 const {state,db,api}=fixture(q);api.request=async()=>{state.order.erp_live.bc.id=999;return {Order:clone(q.bc)}};
 await assert.rejects(refreshErplainDocuments(db,api,q.id),/Documents locaux modifiés/);assert.equal(state.order.erp_live.bc.id,999);assert.equal(state.jobs[0].error,q.jobs[0].error);
});
for(const channel of ['tender','samples','amazon','shopify','temu','erplain','relay','rakuten'])test('canal '+channel+' : rapprochement technique sans action métier',async()=>{
 const {state,db}=fixture(q);state.order.channel=channel;const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.equal(result.concordant,true);assert.equal(state.jobs[0].status,'review');assert.deepEqual(state.erp,q.erp);
});

test('écart réapparu après concordance : rétablir diagnostic frais et garder historique original',async()=>{
 const {state,db}=fixture(q);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.equal(state.jobs[0].error,null);
 const changed=clone(q.bc);changed.line_items[0].quantity+=7;await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,changed));assert.equal(state.jobs[0].error,null);assert.equal(state.jobs[0].result.bcComparisonRefresh.previousError,q.jobs[0].error);assert.equal(state.jobs[0].status,'review');
 await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.equal(state.jobs[0].error,null);assert.equal(state.jobs[0].result.bcComparisonRefresh.previousError,q.jobs[0].error);
});

for(const ref of ['Q1936380','PH2/00638941'])test('course requêtes même BC '+ref+' : ne pas remplacer une projection plus récente',async()=>{
 const entry=live.orders.find(x=>x.reference===ref),{state,db,api}=fixture(entry);api.request=async()=>{state.order.erp_live.bc.line_items[0].quantity=999;state.order.erp_live.documentSource={checkedAt:'newer-read'};return {Order:clone(entry.bc)}};
 await assert.rejects(refreshErplainDocuments(db,api,entry.id),/Documents locaux modifiés/);assert.equal(state.order.erp_live.bc.line_items[0].quantity,999);assert.equal(state.order.erp_live.documentSource.checkedAt,'newer-read');assert.equal(state.jobs[0].error,entry.jobs[0].error);
});
test('interruption du rapprochement partiel : rollback projection et diagnostics ensemble',async()=>{
 const entry=live.orders[0],{state,db,api}=fixture(entry),before=clone(state),query=db.query;
 db.query=async(sql,args)=>{if(sql.startsWith('SELECT id,error,result,action FROM resolution_jobs'))throw Error('Interruption transaction');return query(sql,args)};
 await assert.rejects(refreshErplainDocuments(db,api,entry.id),/Interruption transaction/);assert.deepEqual(state,before);
});

for(const value of [null,['ancienne-preuve'],'ancienne-preuve',true])test('historique de résultat non objet préservé '+JSON.stringify(value),async()=>{const {state,db}=fixture(q);state.jobs[0].result=clone(value);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.deepEqual(state.jobs[0].result.previousResult,value);assert.equal(state.jobs[0].error,null);assert.equal(state.jobs[0].status,'review')});

test('ancien résultat compare-bc : affichage frais et snapshot historique conservé',async()=>{const {state,db}=fixture(q),j=state.jobs.find(j=>j.action==='compare-bc');j.result={bc:{id:q.bc.id,line_items:[{quantity:1}]},comparison:{different:true},errors:[{message:'ancien écart'}],readOnly:true};const before=clone(j.result);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.deepEqual(j.result.bc.line_items,q.bc.line_items);assert.equal(j.result.comparison.different,false);assert.deepEqual(j.result.errors,[]);assert.deepEqual(j.result.bcComparisonRefresh.previousResult,before);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.deepEqual(j.result.bcComparisonRefresh.previousResult,before);assert.equal(j.status,'review')});
