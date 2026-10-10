import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
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
});
