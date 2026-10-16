import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {parseOrders,previewOrders,importOrders} from '../src/imports.mjs';
import {completeShopifyFileOrders} from '../src/shopify-file-import.mjs';
import {normalizeShopifyOrders} from '../src/marketplace-local-import.mjs';

const headers=['Name','Lineitem sku','Lineitem quantity','Shipping Name','Shipping Address1','Shipping Address2','Shipping Zip','Shipping City','Shipping Country','Shipping Phone','Created at','Shipping Method','Cancelled at','Id','Currency'];
const rows=[['#1001','SKU-A',2,'Alice','1 rue Test','Bâtiment B','01230','Paris','FR','+33123456789','2026-10-12 10:00:00 +0100','GLS BusinessParcel',''],['#1001','SKU-B',1],['#1002','SKU-A',3,'Bob','2 rue Test','','75001','Paris','FR']];
rows[0][13]='1001';rows[0][14]='EUR';rows[2][13]='1002';rows[2][14]='EUR';
const reader={shop:'example.myshopify.com',async order(id){const r=rows.find(r=>r[13]===id);return {id,name:r[0],created_at:r[10]||'2026-10-12T10:00:00Z',currency:'EUR',taxes_included:true,line_items:rows.filter(l=>l[0]===r[0]).map((l,i)=>({id:id+'-'+i,sku:l[1],quantity:l[2],price:'10.00',tax_lines:[],discount_allocations:[]})),shipping_address:{name:r[3],address1:r[4],address2:r[5],zip:r[6],city:r[7],country_code:r[8],phone:r[9]},shipping_lines:[]};}};
function csv(data=rows){return Buffer.from([headers,...data].map(r=>r.join(';')).join('\n'));}

test('Shopify CSV groups products and retains shipping information',async()=>{
 const result=await parseOrders(csv(),'orders.csv','shopify');
 assert.equal(result.errors.length,0);assert.equal(result.valid.length,2);
 const order=result.valid[0];assert.equal(order.reference,'#1001');assert.equal(order.channel,'shopify');
 assert.equal(order.recipient,'Alice');assert.equal(order.address.postal,'01230');
 assert.equal(order.address.street,'1 rue Test, Bâtiment B');assert.equal(order.lines.length,2);
 assert.deepEqual(order.lines.map(l=>l.quantity),[2,1]);
 assert.deepEqual(order.source_payload.shipping_lines,[{title:'GLS BusinessParcel'}]);
 assert.equal(order.source_payload.importRows.length,2);
});

test('Shopify XLSX preserves numeric postal formatting and handles blank continuation references',async()=>{
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Orders');sheet.addRow(headers);
 sheet.addRow([...rows[0]]);sheet.getCell('G2').value=1230;sheet.getCell('G2').numFmt='00000';
 sheet.addRow(['','SKU-B',1]);
 const result=await parseOrders(Buffer.from(await workbook.xlsx.writeBuffer()),'orders.xlsx','shopify');
 assert.equal(result.valid.length,1);assert.equal(result.valid[0].lines.length,2);assert.equal(result.valid[0].address.postal,'01230');
});

test('invalid product blocks the whole order; cancellation uses the shared API status',async()=>{
 const data=[rows[0],['#1001','',1],[...rows[2]]];data[2][12]='2026-10-12';
 const result=await parseOrders(csv(data),'orders.csv','shopify');
 assert.equal(result.errors.length,1);
 assert.ok(result.valid[0].visibilityHold);assert.equal(result.valid[0].lines.length,0);assert.equal(result.valid[1].source_payload.cancelled,true);
});

test('rejects unrelated spreadsheets and orphan product rows',async()=>{
 await assert.rejects(parseOrders(Buffer.from('SKU;Quantity\nA;1'),'other.csv','shopify'),/Colonnes Shopify/);
 const result=await parseOrders(csv([['','A',1]]),'orders.csv','shopify');
 assert.equal(result.valid.length,0);assert.equal(result.errors.length,1);
});

test('preview excludes existing Shopify orders by default',async()=>{
 const db={query:async(sql,params)=>{if(sql.startsWith('SELECT order_id'))return {rows:[]};assert.equal(params[0],'shopify');return {rows:[{id:'existing',channel:'shopify',reference:'#1001',recipient:'Alice',source_payload:{}}]};}};
 const result=await previewOrders(db,csv(),'orders.csv','shopify',{shopifyReader:reader});
 assert.equal(result.newCount,1);assert.equal(result.duplicateCount,1);
 assert.equal(result.orders[0].quantity,3);
});

test('selected Shopify orders use shared persistence and preparation jobs',async()=>{
 const writes=[];
 const tx={query:async(sql,params)=>{
  writes.push({sql,params});
  if(sql.startsWith('INSERT INTO orders'))return {rows:JSON.parse(params[0]).map(o=>({id:o.id}))};
  return {rows:[]};
 }};
 const result=await importOrders({exec:async()=>{},transaction:fn=>fn(tx)},csv(),'orders.csv','shopify',['#1002'],{shopifyReader:reader});
 assert.equal(result.created,1);assert.equal(result.excluded,1);
 const orders=JSON.parse(writes.find(w=>w.sql.startsWith('INSERT INTO orders')).params[0]);
 assert.equal(orders[0].reference,'#1002');assert.equal(orders[0].channel,'shopify');
 const jobs=JSON.parse(writes.find(w=>w.sql.startsWith('INSERT INTO jobs')).params[0]);
 assert.deepEqual(jobs.map(j=>j.kind),['label','erp']);
 const savedLines=JSON.parse(writes.find(w=>w.sql.startsWith('INSERT INTO lines')).params[0]);
 assert.equal(savedLines[0].source_line,'1002-0');
 assert.deepEqual(savedLines[0].source_payload.discount_allocations,[]);
 assert.equal(orders[0].source_payload.taxes_included,true);
});

test('wrapped export record is unpacked, including quoted commas and postal apostrophe',async()=>{
 const row=[...rows[0]];row[6]="'01230";row[3]='Client, Test';
 const encode=r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
 const inner=encode(row),outer='"'+inner.replaceAll('"','""')+'"';
 const result=await parseOrders(Buffer.from(headers.join(',')+'\n'+outer),'orders.csv','shopify');
 assert.equal(result.errors.length,0);assert.equal(result.valid[0].reference,'#1001');
 assert.equal(result.valid[0].recipient,'Client, Test');assert.equal(result.valid[0].address.postal,'01230');
 assert.equal(result.valid[0].source_payload.id,'1001');assert.equal(result.valid[0].lines[0].quantity,2);
});

test('API completion produces the same address, real lines, pricing and delivery mode as API reception',async()=>{
 const parsed=await parseOrders(csv(),'orders.csv','shopify');
 const api={shop:reader.shop,async order(id){const payload=await reader.order(id);payload.financial_status='paid';payload.fulfillment_status='fulfilled';payload.shipping_lines=[{title:'GLS BusinessParcel',discounted_price:'0',tax_lines:[]}];return payload;}};
 const expected=normalizeShopifyOrders([await api.order('1001')])[0];
 await completeShopifyFileOrders(parsed,api);
 const actual=parsed.valid[0];
 assert.equal(parsed.errors.length,0);assert.deepEqual(actual.address,expected.address);
 assert.deepEqual(actual.lines.map(l=>l.source_payload),expected.lines.map(l=>l.source_payload));
 assert.equal(actual.source_payload.shopifyDeliveryMode,expected.source_payload.shopifyDeliveryMode);
 assert.equal(actual.source_payload.fulfillment_status,'fulfilled');assert.ok(!actual.visibilityHold);
});

test('missing Id, wrong source identity and changed quantities hold preparation',async()=>{
 for(const api of [{order:async()=>({...await reader.order('1001'),id:'999'})},{order:async()=>({...await reader.order('1001'),line_items:[{id:'L',sku:'SKU-A',quantity:99}]})}]){
  const parsed=await parseOrders(csv([rows[0],rows[1]]),'orders.csv','shopify');
  await completeShopifyFileOrders(parsed,api);
  assert.equal(parsed.errors.length,1);assert.ok(parsed.valid[0].visibilityHold);assert.equal(parsed.valid[0].lines.length,0);
 }
 const row=[...rows[0]];row[13]='';
 const parsed=await parseOrders(csv([row]),'orders.csv','shopify');
 await completeShopifyFileOrders(parsed,reader);
 assert.match(parsed.errors[0].message,/Id/);
});

test('missing API configuration allows file-only import without fabricated pricing',async()=>{
 for(const api of [undefined,async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}]){
  const parsed=await parseOrders(csv([rows[0],rows[1]]),'orders.csv','shopify');
  await completeShopifyFileOrders(parsed,api);
  assert.equal(parsed.errors.length,0);assert.ok(!parsed.valid[0].visibilityHold);
  assert.equal(parsed.valid[0].lines.length,2);
  assert.equal(parsed.valid[0].source_payload.importNeedsApiDetails,true);
  assert.equal(parsed.valid[0].source_payload.taxes_included,undefined);
 }
});

test('API refunds use the same cancellation flag as API normalization',async()=>{
 const parsed=await parseOrders(csv([rows[2]]),'orders.csv','shopify');
 await completeShopifyFileOrders(parsed,{order:async id=>({...await reader.order(id),financial_status:'refunded'})});
 assert.equal(parsed.valid[0].source_payload.cancelled,true);
});

test('API is only called for selected orders on confirmation',async()=>{
 const called=[];
 const tx={query:async(sql,params)=>sql.startsWith('INSERT INTO orders')?{rows:JSON.parse(params[0]).map(o=>({id:o.id}))}:{rows:[]}};
 await importOrders({exec:async()=>{},transaction:fn=>fn(tx)},csv(),'orders.csv','shopify',['#1002'],{shopifyReader:{order:async id=>{called.push(id);return reader.order(id);}}});
 assert.deepEqual(called,['1002']);
});

test('Shopify XLSX with CSV records in column A supports plain and wrapped records',async()=>{
 const encode=r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
 for(const wrapped of [false,true]){
  const w=new ExcelJS.Workbook(),sheet=w.addWorksheet('Orders');
  sheet.addRow([headers.join(',')]);
  const row=[...rows[0]];row[3]='Client, Test';row[6]="'01230";
  for(const r of [row,rows[1]]){
   const record=encode(r);
   sheet.addRow([wrapped?'"'+record.replaceAll('"','""')+'"':record]);
  }
  const parsed=await parseOrders(Buffer.from(await w.xlsx.writeBuffer()),'orders.xlsx','shopify');
  assert.equal(parsed.errors.length,0);assert.equal(parsed.valid.length,1);
  assert.equal(parsed.valid[0].recipient,'Client, Test');assert.equal(parsed.valid[0].address.postal,'01230');
  assert.deepEqual(parsed.valid[0].lines.map(l=>l.quantity),[2,1]);
  await completeShopifyFileOrders(parsed,reader);
  assert.equal(parsed.errors.length,0);assert.equal(parsed.valid[0].lines[0].source_line,'1001-0');
 }
});

test('packed Excel records retain delimiter handling, reject malformed records and formulas',async()=>{
 const w=new ExcelJS.Workbook(),sheet=w.addWorksheet('Orders');sheet.addRow([headers.join(';')]);sheet.addRow([rows[0].join(';')]);
 let parsed=await parseOrders(Buffer.from(await w.xlsx.writeBuffer()),'orders.xlsx','shopify');
 assert.equal(parsed.errors.length,0);assert.equal(parsed.valid[0].reference,'#1001');
 sheet.getCell('A2').value={formula:'1+1',result:2};
 await assert.rejects(parseOrders(Buffer.from(await w.xlsx.writeBuffer()),'orders.xlsx','shopify'),/formules/);
 sheet.getCell('A2').value=rows[0].join(';')+';extra';
 await assert.rejects(parseOrders(Buffer.from(await w.xlsx.writeBuffer()),'orders.xlsx','shopify'),/Nombre de colonnes/);
});
