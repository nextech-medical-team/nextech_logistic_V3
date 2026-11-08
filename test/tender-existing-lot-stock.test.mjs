import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBlBatchNumbers} from '../src/bl-batch-required.mjs';
const line={variant:{id:'10',sku:'P10'},quantity:2};
function fixture({tracked=true,batches=[{id:'1',label:'LOT-1',variant_id:'10'}],failed=false}={}){
 const calls=[];return {calls,async request(q,v){calls.push(q);assert.match(q,/^query /);if(failed)throw Error('API indisponible');if(q.includes('V3BlTenderProductOrders'))return {Orders:{data:[{id:'1',account_representative:{id:'9',label:'Appels d’offres'},line_items:[line]}],paginatorInfo:{hasMorePages:false,currentPage:1}}};if(q.includes('V3BlBatchVariant'))return {Variant:{id:v.id,has_batch_numbers:tracked}};if(q.includes('V3BlBatchNumbers'))return {BatchNumbers:{data:batches,paginatorInfo:{hasMorePages:false}}};throw Error('Requête inattendue');}};
}
for(const tracked of [true,false])test('named tender lot is accepted, tracking='+tracked,async()=>{await assertBlBatchNumbers(fixture({tracked}),{channel:'tender'},[line]);});
for(const tracked of [true,false])test('no tender lot blocks, tracking='+tracked,async()=>{await assert.rejects(()=>assertBlBatchNumbers(fixture({tracked,batches:[]}),{channel:'tender'},[line]),/numéro de lot absent/);});
test('empty or cross-product lot cannot satisfy tender rule',async()=>{for(const batches of [[{id:'1',label:'  ',variant_id:'10'}],[{id:'1',label:'LOT',variant_id:'99'}]])await assert.rejects(()=>assertBlBatchNumbers(fixture({batches}),{channel:'tender'},[line]));});
test('previously exempt tender SKU still needs a lot',async()=>{await assert.rejects(()=>assertBlBatchNumbers(fixture({batches:[]}),{channel:'tender'},[{...line,variant:{id:'10',sku:'2311859-02'}}]),/numéro de lot absent/);});
for(const channel of ['amazon','temu','shopify'])test(channel+' keeps the existing tracking check',async()=>{await assert.rejects(()=>assertBlBatchNumbers(fixture({tracked:false}),{channel},[line]),/activer la gestion des lots/);});
test('marketplace explicit SKU exemption is preserved',async()=>{for(const channel of ['amazon','temu','shopify']){const api=fixture({failed:true});await assertBlBatchNumbers(api,{channel},[{...line,variant:{id:'10',sku:'2311859-02'}}]);assert.equal(api.calls.length,0);}});
test('failed API reads cannot admit a BL',async()=>{await assert.rejects(()=>assertBlBatchNumbers(fixture({failed:true}),{channel:'tender'},[line]),/API indisponible/);});
test('retry rereads actual batches without a positive cache',async()=>{const api=fixture();await assertBlBatchNumbers(api,{channel:'tender'},[line]);await assertBlBatchNumbers(api,{channel:'tender'},[line]);assert.equal(api.calls.length,4);});
