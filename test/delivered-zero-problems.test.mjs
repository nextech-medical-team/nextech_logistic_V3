import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {isDeliveredOrder,projectDeliveredOrder,deliveredOrderSql} from '../src/delivered-order.mjs';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {orderProblemLabels} from '../src/problem-typology.mjs';
import {activeProblemOrderSql} from '../src/order-query.mjs';
import {correctionStatusSnapshot} from '../src/correction-status-check.mjs';
import {processingView} from '../src/order-priority.mjs';
import {refreshErplainDocuments} from '../src/erplain-documents-sync.mjs';
import {monitoringObservation} from '../src/order-recheck-monitor.mjs';

const erp=(statuses=['delivered'],quantities=[[100,100],[400,400]])=>({bc:{id:1935181,line_items:quantities.map(([quantity,shipped_quantity],i)=>({id:i+1,variant:{sku:'SKU'+i},quantity,shipped_quantity})),shipping_orders:{data:statuses.map((status,i)=>({id:i+10,status})),paginatorInfo:{hasMorePages:false}}}});
function dirty(channel='erplain'){return {id:'o',channel,tracking_status:'delivered',label_status:'blocked',erp_status:'live_review',issue:'Stock insuffisant ; choisir le circuit de préparation',resolution_error:'HTTP 500',resolution_pending_resume:true,resolution_active:{id:'r'},label_manual_request_required:true,source_payload:{},erp_live:{},erp_live_job:{status:'review',error:'Poids manquant'},carrier_job:{status:'failed',error:'Résultat incertain'},temu_job:{status:'uncertain',error:'Erreur TEMU'},pending_equivalent:{error:'Remplacement refusé'},sku_lines:[{catalog_issue:'Mapping absent',mapping_exists:false}],extra_parcels:[{status:'failed',error:'HTTP 500'}],resolution_actions:[{status:'review',error:'Adresse manquante'}]};}

test('delivered closes every active diagnostic immediately on the same projection, all channels and no PDF requirement',()=>{
 for(const channel of ['erplain','amazon','shopify','temu','tender','samples']){
  const source=dirty(channel),before=JSON.stringify(source),o=projectCurrentDiagnostics(structuredClone(source));
  assert.equal(o.order_delivered,true);assert.equal(o.issue,null);assert.equal(o.resolution_error,null);assert.equal(o.resolution_pending_resume,false);assert.equal(o.resolution_active,null);
  assert.equal(o.label_status,'delivered');
  for(const node of [o.erp_live_job,o.carrier_job,o.temu_job,o.pending_equivalent,...o.extra_parcels,...o.resolution_actions])assert.equal(node.error,null);
  assert.equal(o.sku_lines[0].catalog_issue,null);assert.equal(currentProblemClassifier()(o).length,0);assert.deepEqual(orderProblemLabels(o,()=>[{label:'Any error'}],true),[]);
  assert.deepEqual(correctionStatusSnapshot(source,{erpJob:{error:'Any'},otherReviews:[{error:'Any'}]}).blockers,[]);
  const twice=JSON.stringify(o);projectCurrentDiagnostics(o);assert.equal(JSON.stringify(o),twice);assert.equal(JSON.stringify(source),before);
 }
});
test('ERP delivery is whole order, not first delivered BL, duplicate SKU, shipped status or commercial completion',()=>{
 assert.equal(isDeliveredOrder({erp_live:erp()}),true);
 for(const statuses of [['delivered','in_preparation'],['shipped'],['ready_to_ship'],['cancelled'],['completed']])assert.equal(isDeliveredOrder({erp_live:erp(statuses)}),false);
 assert.equal(isDeliveredOrder({erp_live:erp(['delivered','cancelled'])}),true);
 assert.equal(isDeliveredOrder({erp_live:erp(['delivered'],[[40,40],[40,0]])}),false);
 assert.equal(isDeliveredOrder({erp_live:erp(['delivered'],[[100,null]])}),false);
 const incomplete=erp();incomplete.bc.shipping_orders.paginatorInfo.hasMorePages=true;assert.equal(isDeliveredOrder({erp_live:incomplete}),false);
 const stale=erp();stale.documentSource={shippingOrders:[{id:99,status:'in_preparation'}]};assert.equal(isDeliveredOrder({erp_live:stale}),false);
 assert.equal(isDeliveredOrder({tracking_status:'delivered_simulated'}),false);
});
test('non delivered errors remain actionable, including every partial remainder',()=>{
 for(const tracking_status of ['unknown','shipped','not_shipped']){
  const o={...dirty(),tracking_status,partial_mode:true,partial_allocation:[{remaining:1}]};const before=JSON.stringify(o);
  assert.equal(projectDeliveredOrder(o),false);assert.ok(currentProblemClassifier()(o).length);assert.equal(JSON.stringify(o),before);
 }
});
test('persisting billing/preparation workflows retain their diagnostic policy, read responses still close every error',()=>{
 const source={...dirty(),issue:'Stock insuffisant',source_payload:{}};
 const stored=projectCurrentDiagnostics(structuredClone(source),{delivery:false});
 assert.equal(stored.issue,'Stock insuffisant');assert.equal(stored.label_status,'blocked');assert.equal(stored.resolution_pending_resume,true);
 const view=projectCurrentDiagnostics(structuredClone(stored));assert.equal(view.issue,null);assert.equal(view.label_status,'delivered');assert.equal(view.resolution_pending_resume,false);
});
test('SQL and the browser/server predicate agree before pagination, counts and fallback',async()=>{
 const db=new PGlite();
 try{
  await db.exec("CREATE TABLE orders(id text,tracking_status text,erp_live jsonb,archived boolean default false,suspension jsonb default '{}',label_status text default 'blocked');");
  const fixtures=[{tracking_status:'delivered'}, {tracking_status:'delivered_simulated'}, {erp_live:erp()}, {erp_live:erp(['delivered','in_preparation'])}, {erp_live:erp(['delivered'],[[40,40],[40,0]])}, {erp_live:erp(['delivered','cancelled'])}, {erp_live:erp(['shipped'])}, {erp_live:{bc:{status:'completed'}}}, {erp_live:erp(['delivered'],[[100,null]])}];
  for(let i=0;i<fixtures.length;i++)await db.query('INSERT INTO orders(id,tracking_status,erp_live) VALUES($1,$2,$3)',[String(i),fixtures[i].tracking_status||null,JSON.stringify(fixtures[i].erp_live||{})]);
  const result=(await db.query(`SELECT id,${deliveredOrderSql} delivered FROM orders ORDER BY id`)).rows;
  for(const row of result)assert.equal(row.delivered,isDeliveredOrder(fixtures[Number(row.id)]),row.id);
  const active=(await db.query(`SELECT id FROM orders WHERE ${activeProblemOrderSql} ORDER BY id`)).rows.map(r=>r.id);
  assert.deepEqual(active,['1','3','4','6','7','8']);
 }finally{await db.close();}
});
test('the same served UI suppresses generic fallback, transport preparation and processing monitor on delivery',()=>{
 const context=vm.createContext({orderProblemText:()=> 'Any old error'});vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),context);
 const o=dirty();assert.equal(context.compactProblems(o).length,0);assert.equal(context.orderProblemText(o),'');assert.equal(context.transportPendingText(o),'Livrée · aucun problème à gérer');
 const p=processingView({id:'o',tracking_status:'delivered',erp_status:'review',erp_error:'Any',carrier_status:'failed',carrier_error:'Any',suspension:{active:true}});
 assert.deepEqual(p.activities,[]);assert.equal(p.stage,null);assert.equal(p.canPrioritize,false);
 const monitor=monitoringObservation(o,{blocked:true,followUp:true,alert:true,result:'Ancien refus'});
 assert.equal(monitor.blocked,false);assert.equal(monitor.followUp,false);assert.equal(monitor.alert,false);assert.equal(monitor.result,'Livrée · aucun problème à gérer');
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');vm.runInContext(app.slice(app.lastIndexOf('function deliveredOrderHtml(')),context);
 const html=context.deliveredOrderHtml({...dirty(),document_count:1,carrier_job:{environment:'production'},temu_documents:[{package:'PK'}],reference:'TEST'});
 assert.match(html,/▤ PDF PROD 1\/1 ↗/);assert.match(html,/▤ PDF TEMU ↗/);assert.match(html,/Livrée · aucun problème à gérer/);
});
test('fresh ERP delivery closes problems in the refresh request before stock or recovery controls',async()=>{
 const bc={...erp().bc,id:1935181,label:'BC',status:'active',update_stock:true};
 const order={id:'o',channel:'erplain',tracking_status:'shipped',source_payload:{erplainImported:true,account:'live'},erp_live:{bc:{...bc},bl:{id:10,status:'shipped'},stockDocument:{id:'stock-that-must-not-be-read'}}};
 const writes=[],calls=[];
 const db={transaction:async fn=>fn(db),query:async(q,p)=>{if(q.startsWith('UPDATE')){writes.push({q,p});return {rows:[]};}return {rows:q.startsWith('SELECT * FROM orders')?[order]:[]};}};
 const api={verify:async()=>{},request:async(q)=>{calls.push(q);if(q.includes('StockRemoval'))throw Error('Must not read stock after delivery');if(q.includes('ShippingOrder('))return {ShippingOrder:bc.shipping_orders.data[0]};if(q.includes('Order('))return {Order:bc};throw Error('Unexpected API');}};
 const result=await refreshErplainDocuments(db,api,'o');
 assert.equal(result.delivered,true);assert.deepEqual(result.stockHolds,[]);assert.equal(result.comparison,null);
 assert.equal(writes.length,1);assert.match(writes[0].q,/SET erp_live=/);assert.equal(JSON.parse(writes[0].p[1]).bl.status,'delivered');
 assert.ok(!calls.some(q=>q.includes('StockRemoval')));assert.ok(!writes.some(x=>/lines|carrier_jobs|tracking_status|issue=/.test(x.q)));
});
