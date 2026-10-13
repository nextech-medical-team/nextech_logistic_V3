import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeEquivalences,rememberEquivalence,importEquivalenceHistory,equivalenceApi} from '../src/equivalence-catalog.mjs';
import fs from 'node:fs';import vm from 'node:vm';
test('replacement and historical import preserve existing manual pairs without learning new pairs',async()=>{
 const db=new PGlite();try{await initializeEquivalences(db);await db.query("INSERT INTO product_equivalences(sku_a,sku_b,origin) VALUES('A','B','manual')");
 await rememberEquivalence(db,'C','D');await rememberEquivalence(db,'A','B');await importEquivalenceHistory(db);
 const rows=(await db.query('SELECT sku_a,sku_b,origin FROM product_equivalences')).rows;assert.deepEqual(rows,[{sku_a:'A',sku_b:'B',origin:'manual'}]);
 }finally{await db.close();}
});
test('suggestions endpoint returns no candidates and performs no catalogue or provider read',async()=>{
 let response;const handled=await equivalenceApi({p:'/api/equivalences/suggestions',url:new URL('https://v3.test/api/equivalences/suggestions?sku=A'),req:{method:'GET'},json:(_res,status,data)=>{assert.equal(status,200);response=data;},db:{query(){throw Error('unexpected read');}},api:{request(){throw Error('unexpected provider read');}}});assert.equal(handled,true);assert.deepEqual(response,{rows:[]});
});
test('a full unconfirmed replacement keeps stock action on the original SKU',()=>{
 const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),ctx);
 for(const quantity of [1,4]){const o={channel:'amazon',sku_lines:[{sku:'D013ECX',quantity}],pending_equivalent:{sku:'D013ECX',replacementSku:'E080ECX',replaceQuantity:quantity,error:'Produit équivalent vérifié : confirmer le remplacement'},erp_live_job:{error:`BL bloqué — stock insuffisant : D013ECX : ${quantity} nécessaires, 0 utilisables, manque ${quantity}`}};
 const problems=ctx.compactProblems(o);assert.ok(problems.some(p=>p.type==='stock'&&p.sku==='D013ECX'));assert.ok(problems.some(p=>p.type==='equivalent-pending'));}
});

test('only an explicit manual catalogue save records a new pair and its author',async()=>{
 const db=new PGlite();try{await initializeEquivalences(db);await db.exec('CREATE TABLE audit(user_email text,action text,detail jsonb)');
 await equivalenceApi({p:'/api/equivalences',req:{method:'POST'},db,user:{email:'operator@example.test'},body:async()=>({sku_a:'B',sku_b:'A',active:false,notes:'manual'}),permitted:()=>{},json:(_res,status)=>assert.equal(status,200)});
 assert.deepEqual((await db.query('SELECT sku_a,sku_b,origin,active FROM product_equivalences')).rows,[{sku_a:'A',sku_b:'B',origin:'manual',active:false}]);
 assert.deepEqual((await db.query('SELECT user_email,action FROM audit')).rows,[{user_email:'operator@example.test',action:'equivalence.saved'}]);
 }finally{await db.close();}
});
