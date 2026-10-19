import test from 'node:test';
import assert from 'node:assert/strict';
import {historicalPreparationProof} from '../src/historical-stock-proof.mjs';
import {representativeLabels} from '../src/erplain-document-metadata.mjs';
const conn=data=>({data,paginatorInfo:{hasMorePages:false}});
function fixture({stock=-20,available=stock,channel='temu',blStatus=null}={}){
 const line={id:10,type:'normal',quantity:10,reserved_quantity:0,shipped_quantity:0,on_hand:stock,available,location:{id:3},variant:{id:2,sku:'audit-product',track_inventory:true}};
 const bl=blStatus?{id:9,created_at:'2026-10-15 18:28:53',status:blStatus,update_stock:true,orders:conn([{id:1}]),line_items:[{...line,parent_id:10}]}:null;
 const bc={id:1,created_at:'2026-10-15 17:11:55',status:'active',update_stock:true,line_items:[line],shipping_orders:conn(bl&&blStatus!=='unpublished'?[bl]:[])};
 const o={id:'audit-order',channel,items:[line],erp_live:{bc:{id:1},...(bl?{bl:{id:9,status:blStatus}}:{})}};
 const calls=[];const api={request:async q=>{calls.push(q);assert.match(q,/^query /);if(q.includes('V3HistoricalPreparationBL'))return {ShippingOrder:bl};if(q.includes('V3HistoricalPreparation('))return {Order:bc};if(q.includes('V3HistoricalExtraStock'))return {StockRemovals:conn([])};if(q.includes('V3InheritedBlLedger'))return {InventoryLogs:conn([])};if(q.includes('V3HistoricalStockLogs'))return {InventoryLogs:conn([{id:7,document_id:1,order_type:'Order',on_hand_diff:-10,available_diff:-10,variant:{id:2},location:{id:3}}])};throw Error('Unexpected query');}};
 return {line,bc,o,calls,run:(beforeBlPublication=true)=>historicalPreparationProof(api,o,{beforeBlPublication})};
}
for(const blStatus of [null,'unpublished'])test('negative BC balance blocks prepublication '+blStatus,async()=>{const f=fixture({blStatus});await assert.rejects(()=>f.run(),/stock insuffisant/);});
for(const stock of [0,5,100])test('covered exact debit accepts remaining stock '+stock,async()=>{const f=fixture({stock});assert.equal((await f.run()).stockOnBc,true);});
test('negative available balance also blocks',async()=>{await assert.rejects(()=>fixture({stock:100,available:-1}).run(),/stock insuffisant/);});
for(const stock of [null,'',false,NaN])test('unknown stock balance refuses '+String(stock),async()=>{await assert.rejects(()=>fixture({stock}).run(),/Stock non vérifiable/);});
test('existing published BL remains readable despite later negative stock',async()=>{const f=fixture({blStatus:'ready_to_ship'});assert.equal((await f.run()).stockOnBc,true);assert.equal((await f.run(false)).stockOnBc,true);});
test('tender negative debit blocks before a new BL',async()=>{await assert.rejects(()=>fixture({channel:'tender'}).run(),/stock insuffisant/);});
for(const channel of [...Object.keys(representativeLabels),'erplain'])for(const blStatus of [null,'unpublished'])for(const imported of [false,true])test(`${channel} historical negative balance: draft=${blStatus} imported=${imported}`,async()=>{
 const f=fixture({channel,blStatus});if(imported)f.o.source_payload={erplainImported:true,account:'live'};
 await assert.rejects(()=>f.run(),/stock insuffisant/);
 assert.ok(f.calls.every(q=>q.startsWith('query ')));
});
test('ordinary historical reading is preserved',async()=>{assert.equal((await fixture().run(false)).stockOnBc,true);});
