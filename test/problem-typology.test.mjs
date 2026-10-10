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
const execute=new AsyncFunction('p','req','url','db','orderQuery','managerSql','partialAllocationSql','orderPageDetails','projectCurrentDiagnostics','readerJobs','catalog','selectProblemOrders','paginateProblemOrders','currentProblemClassifier','orderStatistics','cachedOrderSummary','json','res',server.slice(start,end));
async function route(path,query){
 const rows=Array.from({length:120},(_,i)=>({id:String(i),issue:i>=100?'Commande déjà expédiée sur la plateforme':'',label_status:'pending',source_payload:{},sku_lines:[]}));
 let out,sql,statsIds;
 const db={query:async(q,args)=>{if(q.startsWith('SELECT id FROM orders'))return {rows:rows.filter(o=>o.issue).map(o=>({id:o.id}))};sql={q,args};return {rows:structuredClone(rows)};}};
 await execute(path,{method:'GET'},new URL('https://example.test'+path+'?'+query),db,orderQuery,'NULL','NULL',async()=>{},o=>o,{snapshot:async()=>({configured:true})},{status:()=>({})},selectProblemOrders,paginateProblemOrders,currentProblemClassifier,async(_db,_params,ids)=>{statsIds=ids;return {transportStats:[],summary:{total:ids.length}};},async()=>({transportStats:[],summary:{total:120}}),(_res,status,data)=>{assert.equal(status,200);out=data;},{});
 return {out,sql,statsIds};
}
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
