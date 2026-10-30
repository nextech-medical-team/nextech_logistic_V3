import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBlBatchNumbers} from '../src/bl-batch-required.mjs';

const line=(id='10',sku='SKU-'+id)=>({type:'normal',quantity:2,variant:{id,sku}});
const bc=(id='bc',variant='10',label='Appels d’offres')=>({id,account_representative:{id:'manager',label},line_items:[line(variant)]});
const page=(data=[],currentPage=1,hasMorePages=false)=>({data,paginatorInfo:{currentPage,hasMorePages}});
function fixture({orders=v=>page([bc('bc',v.where.value)],v.page),tracked=true,batches=true}={}){
 const calls=[];
 return {calls,async request(query,v){
  assert.match(query,/^query /);calls.push({query,v});
  if(query.includes('V3BlTenderProductOrders')){
   assert.deepEqual(v.where,{column:'VARIANT_ID',operator:'EXISTS',value:v.where.value});
   return {Orders:await orders(v)};
  }
  if(query.includes('V3BlBatchVariant'))return {Variant:{id:v.id,has_batch_numbers:tracked}};
  if(query.includes('V3BlBatchNumbers'))return {BatchNumbers:{data:batches?[{id:'batch',label:'LOT',variant_id:v.where.value}]:[],paginatorInfo:{hasMorePages:false}}};
  assert.fail('Unexpected read '+query);
 }};
}

for(const channel of ['amazon','temu','shopify']){
 test(channel+': shared tender product blocks without lots',async()=>{
  const api=fixture({batches:false});await assert.rejects(assertBlBatchNumbers(api,{channel},[line()]),/SKU-10.*numéro de lot absent/);
 });
 test(channel+': unrelated product passes without batch tracking or batch API calls',async()=>{
  const api=fixture({orders:()=>page(),tracked:false,batches:false});await assertBlBatchNumbers(api,{channel},[line()]);
  assert.equal(api.calls.length,1);assert.match(api.calls[0].query,/V3BlTenderProductOrders/);
 });
 test(channel+': shared tender product with named lot passes',async()=>{
  const api=fixture();await assertBlBatchNumbers(api,{channel},[line()]);assert.equal(api.calls.length,3);
 });
}
test('mixed BL checks only shared variants, deduplicates them, and uses effective Erplain IDs',async()=>{
 const api=fixture({orders:v=>page(v.where.value==='20'?[bc('tender','20')]:[]),batches:false});
 await assert.rejects(assertBlBatchNumbers(api,{channel:'amazon'},[line('10','SAME-SKU'),line('20','SHARED'),line('20','SHARED'),{type:'shipping'}]),error=>{
  assert.match(error.message,/SHARED.*numéro de lot absent/);assert.doesNotMatch(error.message,/SAME-SKU/);return true;
 });
 assert.deepEqual(api.calls.filter(c=>c.query.includes('V3BlTenderProductOrders')).map(c=>c.v.where.value),['10','20']);
 assert.deepEqual(api.calls.filter(c=>c.query.includes('V3BlBatchVariant')).map(c=>c.v.id),['20']);
});
test('tender order blocks every product even if not previously sold under that manager',async()=>{
 const api=fixture({orders:()=>assert.fail('No membership read for tender BL'),tracked:false});
 await assert.rejects(assertBlBatchNumbers(api,{channel:'tender'},[line('10'),line('20')]),error=>/SKU-10/.test(error.message)&&/SKU-20/.test(error.message));
 assert.equal(api.calls.length,2);
});
for(const label of ["Appel d'offres",' APPELS D’OFFRES ','Appels d’offrés'])test('Erplain manager identifies tender BL: '+label,async()=>{
 const api=fixture({tracked:false});await assert.rejects(assertBlBatchNumbers(api,{channel:'erplain',erp_live:{bc:{account_representative:{label}}}},[line()]),/activer la gestion des lots/);
 assert.equal(api.calls.length,1);
});
test('membership scans subsequent pages and accepts historical tender orders',async()=>{
 const api=fixture({orders:v=>v.page===1?page([bc('retail','10','Boutique')],1,true):page([{...bc('historical'),status:'completed'}],2),tracked:false});
 await assert.rejects(assertBlBatchNumbers(api,{channel:'temu'},[line()]),/activer la gestion des lots/);
 assert.equal(api.calls.filter(c=>c.query.includes('V3BlTenderProductOrders')).length,2);
});
test('negative membership requires reading every page, including unassigned and other managers',async()=>{
 const api=fixture({orders:v=>v.page===1?page([{...bc(),account_representative:null}],1,true):page([bc('second','10','Appels commerciaux')],2),tracked:false});
 await assertBlBatchNumbers(api,{channel:'shopify'},[line()]);assert.equal(api.calls.length,2);
});
for(const [name,orders] of Object.entries({
 missing:()=>null,missingPagination:()=>({data:[]}),missingCurrentPage:()=>({data:[],paginatorInfo:{hasMorePages:false}}),
 wrongPage:()=>page([],2),emptyNextPage:()=>page([],1,true),wrongVariant:()=>page([bc('wrong','99')]),
 missingManager:()=>page([{id:'bc',line_items:[line()]}]),emptyManager:()=>page([{...bc(),account_representative:{id:'m',label:''}}]),
 missingLines:()=>page([{id:'bc',account_representative:null}]),repeatedPage:v=>page([bc('same','10','Boutique')],v.page,true),
 endlessPages:v=>page([bc('bc-'+v.page,'10','Boutique')],v.page,true),
}))test('incomplete membership cannot exempt a product: '+name,async()=>{
 const api=fixture({orders});await assert.rejects(assertBlBatchNumbers(api,{channel:'amazon'},[line()]),/SKU-10.*périmètre Appel d’offres non vérifiable.*BL bloquée/);
 assert.ok(api.calls.length<=100);
});
test('read failure blocks only the affected product and still checks remaining lines',async()=>{
 const api=fixture({orders:v=>{if(v.where.value==='10')throw Error('Erplain HTTP 429');return page();}});
 await assert.rejects(assertBlBatchNumbers(api,{channel:'temu'},[line(),line('20')]),error=>{
  assert.match(error.message,/SKU-10.*Erplain HTTP 429/);assert.doesNotMatch(error.message,/SKU-20/);return true;
 });
 assert.equal(api.calls.length,2);
});
test('membership is reread after Erplain changes; no stale exemption is cached',async()=>{
 let used=false;const api=fixture({orders:()=>page(used?[bc()]:[]),batches:false});
 await assertBlBatchNumbers(api,{channel:'shopify'},[line()]);used=true;
 await assert.rejects(assertBlBatchNumbers(api,{channel:'shopify'},[line()]),/numéro de lot absent/);
 used=false;await assertBlBatchNumbers(api,{channel:'shopify'},[line()]);
});
test('non-target channels do not gain an additional batch gate',async()=>{
 const api={request:()=>assert.fail('No batch policy read outside tender and marketplaces')};
 for(const channel of ['samples','erplain',undefined])await assertBlBatchNumbers(api,{channel},[line()]);
});
