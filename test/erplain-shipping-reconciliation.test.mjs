import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileShippingOrderReads} from '../src/erplain-shipping-reconciliation.mjs';
import {recoverOrder} from '../src/erplain-document-metadata.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('one incomplete BL read does not block another order or lose its existing BL',async()=>{
 const orders=Array.from({length:4},(_,i)=>({id:String(i),erp_live:{bc:{id:String(i)}}}));
 const saved=[],failed=[];
 const list=(data,hasMorePages=false)=>({shipping_orders:{data,paginatorInfo:{hasMorePages}}});
 await reconcileShippingOrderReads(orders,{p0:null,p1:list([{id:'existing',status:'pending'}]),p2:list([]),p3:list([{id:'first'},{id:'second'}])},{save:async o=>saved.push(o.id),fail:async(o,e)=>failed.push([o.id,e.message])});
 assert.deepEqual(saved,['1']);assert.deepEqual(failed.map(x=>x[0]),['0','3']);
 assert.equal(orders[1].erp_live.bl.id,'existing');assert.equal(orders[1].failed,undefined);
 assert.equal(orders[2].failed,undefined);assert.equal(orders[2].erp_live.bl,undefined);
 assert.match(failed[0][1],/Réponse BL incomplète/);assert.match(failed[1][1],/multiples/);
});

test('BC search only proves absence with a complete unambiguous provider response',async()=>{
 const o={id:'local',reference:'PO-1-2'};
 const run=result=>recoverOrder({request:async q=>{assert.match(q,/^query /);return result;}},o);
 for(const result of [null,{}, {Orders:{data:[]}}, {Orders:{data:[],paginatorInfo:{}}}])await assert.rejects(run(result),/incomplète/);
 const result=data=>({Orders:{data,paginatorInfo:{hasMorePages:false}}});
 assert.equal(await run(result([])),null);
 const bc={id:'12',status:'unpublished',external_reference:o.reference,internal_notes:'[V3:local]'};
 assert.equal((await run(result([bc]))).id,'12');
 assert.equal((await run(result([{...bc,status:'completed'}]))).id,'12');
 for(const invalid of [{...bc,internal_notes:''},{...bc,status:'cancelled'},{...bc,id:null}])await assert.rejects(run(result([invalid])),/avant création|aucune nouvelle création|identité absente/);
 await assert.rejects(run(result([bc,{...bc,id:'13'}])),/multiples/);
 await assert.rejects(run({Orders:{data:[bc],paginatorInfo:{hasMorePages:true}}}),/Trop de BC/);
});

test('TEMU address refusals explain the provider correction and existing-label route',()=>{
 const source=readFileSync(new URL('../public/problem-corrections.js',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('function temuLabelResolutionNotice'),source.indexOf('function mappingQuantityDefaults'));
 const context=vm.createContext({});vm.runInContext(helper,context);
 for(const detail of ['TEMU · Étiquette refusée : The shipping address contains non-English characters.','TEMU · Adresse : caractères refusés','TEMU · Étiquette refusée : adresse avec caractères non pris en charge par le service d’expédition']){
  const notice=context.temuLabelResolutionNotice({detail},{channel:'temu'});
  assert.match(notice,/TEMU Seller Center/);assert.match(notice,/uniquement l’adresse dans V3 ne corrige pas/);assert.match(notice,/déjà/);
 }
 assert.equal(context.temuLabelResolutionNotice({detail:'Erplain HTTP 429'},{channel:'temu'}),null);
 assert.equal(context.temuLabelResolutionNotice({detail:'Adresse : caractères refusés'},{channel:'shopify'}),null);
});

 test('partial GraphQL quota errors remain read-only and leave other aliases usable',async()=>{
 const orders=[{id:'a',erp_live:{}},{id:'b',erp_live:{}}],errors=[];
 await reconcileShippingOrderReads(orders,{p0:null,p1:{shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},_v3Errors:[{path:['p0'],code:'RATE_LIMITED',message:'Too many requests'}]},{save:async()=>{},fail:async(o,e)=>errors.push(e)});
 assert.equal(errors.length,1);assert.equal(errors[0].httpStatus,429);assert.equal(errors[0].erplainReadOnly,true);
 assert.equal(orders[0].failed,true);assert.equal(orders[1].failed,undefined);
});
