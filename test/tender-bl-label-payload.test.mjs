import test from 'node:test';import assert from 'node:assert/strict';
import {tenderBlLabelPayload,applyTenderBlLabelPayload} from '../src/tender-bl-label-payload.mjs';
const order=()=>({channel:'tender',carrier:'gls_pharma',weight_kg:74500,parcel_count:2484,label_override:false,erp_live:{bc:{id:'bc'},bl:{id:'bl',status:'in_preparation',line_items:[['A',1500],['B',8000],['C',8000],['D',2000]].map(([sku,quantity])=>({type:'normal',quantity,variant:{sku}}))}},source_payload:{original:'unchanged'},lines:[{source_sku:'OLD',target_sku:'OLD',quantity:55000}]});
const db={query:async sql=>{assert.match(sql,/^SELECT sku,weight_kg FROM products/);assert.doesNotMatch(sql,/stock|mapping|available|Erplain/i);return {rows:[['A',.0038],['B',.004],['C',.004],['D',.0068]].map(([sku,weight_kg])=>({sku,weight_kg}))};}};
test('single BL contents produce 83.3 kg and three parcels instead of an obsolete 2484-parcel calculation',async()=>{
 const o=order(),before=JSON.stringify(o),p=await tenderBlLabelPayload(db,o);assert.equal(p.weightKg,83.3);assert.equal(p.parcels,3);assert.deepEqual(p.lines.map(l=>[l.target_sku,l.target_quantity]),[['A',1500],['B',8000],['C',8000],['D',2000]]);assert.equal(JSON.stringify(o),before);
 const shipment=applyTenderBlLabelPayload(o,{blId:'bl',blPayload:p});assert.equal(shipment.weight_kg,83.3);assert.equal(shipment.parcel_count,3);assert.deepEqual(shipment.erp_live,o.erp_live);assert.deepEqual(shipment.source_payload,o.source_payload);assert.equal(JSON.stringify(o),before);
});
test('explicit measured override, another channel and multiple BLs preserve their established payload without a query',async()=>{
 const never={query:()=>{throw Error('No lookup expected');}};
 for(const edit of [o=>o.label_override=true,o=>o.channel='amazon',o=>o.erp_live.documentSource={shippingOrders:[{id:'other',status:'ready_to_ship'}]}]){const o=order();edit(o);assert.equal(await tenderBlLabelPayload(never,o),null);assert.equal(applyTenderBlLabelPayload(o,{blId:'bl'}),o);}
});
test('sparse or unweighted BL data adds no new prerequisite and never invents a product weight',async()=>{
 const o=order();delete o.erp_live.bl.line_items;assert.equal(await tenderBlLabelPayload({query:()=>{throw Error('No query');}},o),null);
 assert.equal(await tenderBlLabelPayload({query:async()=>({rows:[]})},order()),null);
 const invalid=order();invalid.erp_live.bl.line_items[0].quantity=null;assert.equal(await tenderBlLabelPayload({query:()=>{throw Error('No query');}},invalid),null);
});
test('an enriched copy of the same BL remains one delivery; cancelled historical documents do not change the cargo',async()=>{
 const o=order();o.erp_live.documentSource={shippingOrders:[structuredClone(o.erp_live.bl),{id:'old',status:'cancelled'}]};assert.equal((await tenderBlLabelPayload(db,o)).parcels,3);
});
test('a durable request keeps its own BL identity and shipment data instead of reusing changed cached weight',async()=>{
 const o=order(),p=await tenderBlLabelPayload(db,o);o.weight_kg=99999;o.parcel_count=3334;assert.equal(applyTenderBlLabelPayload(o,{blId:'bl',blPayload:p}).parcel_count,3);assert.throws(()=>applyTenderBlLabelPayload(o,{blId:'different',blPayload:p}),/autre BL/);
});
