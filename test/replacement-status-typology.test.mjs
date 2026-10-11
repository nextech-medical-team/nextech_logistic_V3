import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {selectProblemOrders} from '../src/problem-typology.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),ctx);
test('verified remaining or replacement weights belong to replacement confirmation',()=>{
 for(const prefix of ['Produit restant','Produit équivalent']){
  const x=ctx.compactProblem(`${prefix} [SKU] : Poids vérifié, remplacement à confirmer`);
  assert.equal(x.type,'equivalent-pending');assert.equal(x.label,'Confirmer le remplacement');assert.equal(x.sku,'SKU');
 }
});
test('unverified weight, stock and other failures retain their own families',()=>{
 assert.equal(ctx.compactProblem('Produit restant [SKU] : Poids non renseigné dans Erplain').type,'weight');
 assert.equal(ctx.compactProblem('Produit restant [SKU] : Unité de poids Erplain absente ou non prise en charge').type,'weight-unit');
 assert.equal(ctx.compactProblem('Produit restant [SKU] : Stock insuffisant').type,'stock');
 assert.equal(ctx.compactProblem('Produit restant [SKU] : Poids vérifié, remplacement à confirmer ; Erreur inconnue').type,'unknown');
});
test('order-level projection exposes the correct filter family and preserves independent issues',()=>{
 const message='Produit restant [SKU] : Poids vérifié, remplacement à confirmer';
 const o={sku_lines:[{sku:'SKU',quantity:1}],resolution_error:message,pending_equivalent:{sku:'OLD',replacementSku:'NEW',error:message},issue:'SKU : Stock insuffisant'};
 const problems=ctx.compactProblems(o);assert.ok(problems.some(x=>x.type==='equivalent-pending'));assert.ok(problems.some(x=>x.type==='stock'));assert.ok(!problems.some(x=>['weight','weight-unit','unknown'].includes(x.type)));
 assert.equal(o.resolution_error,message);
 const result=selectProblemOrders([{...o,id:'order'}],['Confirmer le remplacement'],currentProblemClassifier());assert.equal(result.total,1);assert.equal(result.problemTypes.find(x=>x.label==='Confirmer le remplacement').count,1);
});

import {PGlite} from '@electric-sql/pglite';import {attachEquivalentDiagnostics} from '../src/equivalent-diagnostics.mjs';import {pendingEquivalentProblemSql} from '../src/order-problem-predicates.mjs';
test('a completed preparation retires an older failed replacement from list and details; product correction alone preserves the decision',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE orders(id text,channel text);CREATE TABLE lines(order_id text,source_sku text,target_sku text);CREATE TABLE mappings(channel text,source_sku text,target_sku text);CREATE TABLE resolution_jobs(id text,order_id text,action text,status text,payload jsonb,result jsonb,error text,created_at timestamptz);INSERT INTO orders VALUES('prepared','temu'),('decision','temu');INSERT INTO lines VALUES('prepared','OLD','OLD'),('decision','OLD','OLD');`);
 for(const id of ['prepared','decision'])await db.query("INSERT INTO resolution_jobs VALUES($1,$2,$3,$4,$5,null,$6,now()-interval '1 hour')",[id+'-preview',id,'equivalent-preview','review',JSON.stringify({sku:'OLD',replacementSku:'NEW'}),'Stock insuffisant']);
 await db.query("INSERT INTO resolution_jobs VALUES('resume','prepared','resume-erp','complete','{}','{}',null,now()),('weight','decision','weight','complete','{\"sku\":\"NEW\"}','{}',null,now())");
 const rows=(await db.query(`SELECT id FROM orders WHERE ${pendingEquivalentProblemSql} ORDER BY id`)).rows;assert.deepEqual(rows.map(r=>r.id),['decision']);const orders=[{id:'prepared'},{id:'decision'}];await attachEquivalentDiagnostics(db,orders);assert.equal(orders[0].pending_equivalent,null);assert.equal(orders[1].pending_equivalent.replacementSku,'NEW');assert.equal((await db.query('SELECT count(*)::int n FROM resolution_jobs')).rows[0].n,4);
 }finally{await db.close();}
});
