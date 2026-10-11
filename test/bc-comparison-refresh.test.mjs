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
test('régression réelle Q1936380 : lien BC relit et rapproche erreur ancienne sans reprise',async()=>{
 const {state,db,api}=fixture(q),before=clone(state);
 const result=await refreshErplainDocuments(db,api,q.id);
 assert.equal(result.bc.id,q.bc.id);assert.deepEqual(result.bc.line_items,q.bc.line_items);
 for(const j of state.jobs){const old=before.jobs.find(x=>x.id===j.id);assert.equal(j.status,old.status);assert.equal(j.action,old.action);if(physicalComparisonErrors.includes(old.error)){assert.equal(j.error,null);assert.equal(j.result.bcComparisonRefresh.previousError,old.error)}else if(physicalComparisonErrors.includes(old.error)&&result.comparison?.different){assert.ok(j.error.includes('V3 ['));assert.equal(j.result.bcComparisonRefresh.previousError,old.error)}else assert.equal(j.error,old.error)}
 assert.deepEqual(state.lines,before.lines);assert.deepEqual(state.erp,before.erp);assert.deepEqual(state.documents,before.documents);assert.deepEqual(state.order.erp_live.pricing,before.order.erp_live.pricing);
 assert.equal(result.comparison.concordant,true);
});
for(const entry of live.orders)test('fixture API/SQL '+entry.reference+' : comparaison actuelle et historique préservé',async()=>{
 const {state,db}=fixture(entry),before=clone(state);
 const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,entry.id,clone(entry.bc)));
 assert.equal(result.concordant,entry.reference!=='2610813');
 assert.deepEqual(result.comparison,entry.diagnostic.comparison);
 for(const j of state.jobs){const old=before.jobs.find(x=>x.id===j.id);assert.equal(j.status,old.status);if(result.concordant&&physicalComparisonErrors.includes(old.error))assert.equal(j.error,null);else if(physicalComparisonErrors.includes(old.error)&&result.comparison?.different){assert.ok(j.error.includes('V3 ['));assert.equal(j.result.bcComparisonRefresh.previousError,old.error)}else assert.equal(j.error,old.error)}
 assert.deepEqual(state.lines,before.lines);assert.deepEqual(state.erp,before.erp);assert.deepEqual(state.documents,before.documents);assert.deepEqual(state.order.erp_live.pricing,before.order.erp_live.pricing);
});
for(const value of [true,false,'', ' ',[],{},Infinity,0,-1])test('quantité source non confirmée '+JSON.stringify(value)+' : ne pas effacer le diagnostic',async()=>{
 const {state,db}=fixture(q),before=clone(state.jobs);state.lines[0].target_quantity=value;
 const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));
 assert.equal(result.concordant,false);for(const j of state.jobs){assert.equal(j.status,before.find(x=>x.id===j.id).status);assert.ok(j.error)}
});
for(const scenario of ['quantité divergente','produit divergent','BC fermé','erreur mixte','source changée','BL local absent'])test(scenario+' : conserver les vrais blocages',async()=>{
 const {state,db}=fixture(q),bc=clone(q.bc);
 if(scenario==='quantité divergente')bc.line_items[0].quantity+=1;
 if(scenario==='produit divergent')bc.line_items[0].variant.sku+='-AUTRE';
 if(scenario==='BC fermé')bc.status='closed';
 if(scenario==='erreur mixte')state.jobs[0].error=physicalComparisonErrors[0]+' ; Stock insuffisant';
 if(scenario==='source changée')state.lines[0].target_quantity=Number(state.lines[0].target_quantity)+1;
 if(scenario==='BL local absent')state.order.erp_live.bl={id:999999};
 const before=clone(state.jobs);const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,bc));
 if(scenario==='erreur mixte')assert.equal(state.jobs[0].error,before[0].error);else{assert.equal(result.concordant,false);for(const j of state.jobs){const old=before.find(x=>x.id===j.id);assert.equal(j.status,old.status);if(physicalComparisonErrors.includes(old.error)&&result.comparison?.different){assert.ok(j.error.includes('V3 ['));assert.equal(j.result.bcComparisonRefresh.previousError,old.error)}else assert.equal(j.error,old.error)}}
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
test('ratio permanent appliqué une fois, quantité explicite limitée au mapping de commande',async()=>{
 for(const explicit of [false,true]){const {state,db}=fixture(q);const sku=state.lines[0].target_sku;state.lines[0]={...state.lines[0],quantity:'5',mapped_sku:sku,target_quantity:explicit?'50':'999',source_qty:'1',target_qty:'10',source_payload:{...state.lines[0].source_payload,...(explicit?{mappingScope:'order'}:{})}};const bc=clone(q.bc);bc.line_items.find(l=>l.variant.sku===sku).quantity=50;const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,bc));assert.equal(result.concordant,true)}
});
test('lecture API interrompue : aucun changement',async()=>{const {state,db,api}=fixture(q),before=clone(state);api.request=async()=>{throw Error('Timeout fournisseur')};await assert.rejects(refreshErplainDocuments(db,api,q.id),/Timeout fournisseur/);assert.deepEqual(state,before)});
test('répétition idempotente : preuve précédente conservée et aucune reprise',async()=>{const {state,db}=fixture(q);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));const first=clone(state.jobs);await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));assert.equal(state.jobs.length,first.length);for(const j of state.jobs){const old=first.find(x=>x.id===j.id);assert.equal(j.error,old.error);assert.equal(j.status,old.status);assert.deepEqual(j.result.bcComparisonRefresh?.previousResult,old.result.bcComparisonRefresh?.previousResult)}});



for(const ref of ['PH2/00638941','2610813'])test('parcours partiel complet réel '+ref+' conserve les documents et la divergence justifiée',async()=>{
 const entry=live.orders.find(x=>x.reference===ref),{state,db,api}=fixture(entry),before=clone(state);
 const result=await refreshErplainDocuments(db,api,entry.id);
 assert.equal(result.comparison.concordant,ref==='PH2/00638941');assert.deepEqual(state.order.erp_live.bc.line_items,entry.bc.line_items);
 assert.deepEqual(state.lines,before.lines);assert.deepEqual(state.erp,before.erp);assert.deepEqual(state.documents,before.documents);assert.deepEqual(state.order.erp_live.pricing,before.order.erp_live.pricing);
 if(ref==='2610813'){assert.ok(state.jobs[0].error.includes('FULL-OPTY × 10'));assert.ok(state.jobs[0].error.includes('FLP1915 × 10'));assert.equal(state.jobs[1].error,before.jobs[1].error)}else assert.equal(state.jobs[0].error,null);
});
for(const value of [true,false,'',' ',[],{},Infinity])test('réponse BC invalide '+JSON.stringify(value)+' : refus avant projection',async()=>{
 for(const entry of [q,live.orders[0]]){const {state,db,api}=fixture(entry),before=clone(state);api.request=async()=>{const bc=clone(entry.bc);bc.line_items[0].quantity=value;return {Order:bc}};await assert.rejects(refreshErplainDocuments(db,api,entry.id));assert.deepEqual(state,before)}
});
test('modification manuelle des quantités BC : afficher courant et garder écart',async()=>{
 const {state,db,api}=fixture(q);api.request=async()=>{const bc=clone(q.bc);bc.line_items[0].quantity=123;return {Order:bc}};
 const result=await refreshErplainDocuments(db,api,q.id);assert.equal(state.order.erp_live.bc.line_items[0].quantity,123);assert.equal(result.comparison.concordant,false);assert.ok(state.jobs[0].error.includes('123'));
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
 const changed=clone(q.bc);changed.line_items[0].quantity+=7;await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,changed));assert.ok(state.jobs[0].error.includes('V3 ['));assert.equal(state.jobs[0].result.bcComparisonRefresh.previousError,q.jobs[0].error);assert.equal(state.jobs[0].status,'review');
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


test('same SKU cannot erase an ERP variant identity error or certify automatic resume',async()=>{
 const {state,db}=fixture(q);state.jobs[0].error='BC · Produits ou quantités des lignes Erplain différents de la source';
 const result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));
 assert.equal(result.comparison.different,false);assert.equal(result.concordant,false);assert.equal(result.identityUnconfirmed,true);
 assert.equal(state.jobs[0].error,'BC · Produits ou quantités des lignes Erplain différents de la source');
});

for(const channel of ['temu','amazon','shopify'])test(channel+' recorded BC read does not compare source quantities or mapping',async()=>{
 const {state,db}=fixture(q);state.order.channel=channel;
 state.lines=state.lines.map(l=>({...l,source_sku:'SOURCE-OTHER',mapped_sku:'OTHER',target_sku:'OTHER',quantity:999,target_quantity:false,source_qty:0,target_qty:1000}));
 const before=clone(state.lines),result=await db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,q.id,clone(q.bc)));
 assert.equal(result.concordant,true);assert.equal(result.authority,'recorded_bc');
 assert.deepEqual(result.comparison.expected,result.comparison.observed);assert.deepEqual(state.lines,before);
 assert.ok(!result.errors.some(e=>['physical_difference','comparison_unconfirmed','variant_identity_unconfirmed'].includes(e.code)));
});
