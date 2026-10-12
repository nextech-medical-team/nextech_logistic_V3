import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {projectCurrentDiagnostics} from '../../src/current-order-diagnostics.mjs';
import {cancelledTemuFulfillment,invalidTemuQuantities} from '../../src/temu-fulfillment-quantities.mjs';
import {currentProblemClassifier} from '../../src/problem-typology-reader.mjs';
import {selectProblemOrders} from '../../src/problem-typology.mjs';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('confirmed TEMU zero remainder is explained '+name,async({page})=>{
 const rows=[false,true].map((stock,i)=>{
  const reference='PO-069-12345678'+i;
  return projectCurrentDiagnostics({id:'cancelled-quantity-'+i,reference,channel:'temu',carrier:'temu',recipient:'Client fictif',address:{country:'FR'},source_date:'2026-10-12',sku_lines:[],source_payload:{temuOrderDetail:{parentOrderMap:{parentOrderSn:reference,parentOrderStatus:3},orderList:[{orderSn:'line-'+i,orderStatus:3,quantity:0,originalOrderQuantity:1,canceledQuantityBeforeShipment:1}]}},erp_live:{bc:{id:1,label:'TEST-BC'},bl:stock?{id:2,label:'TEST-BL'}:null},label_status:'blocked',tracking_status:'unknown',issue:stock?'Bloqué : stock insuffisant':null,temu_job:{status:'api_error',error:invalidTemuQuantities},platform_status:{channel:'temu',status:'3',cancelled:true,indicative:true}});
 });
 const writes=[],errors=[];await page.setViewportSize(viewport);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows,total:2,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/order-problem-types*',r=>r.fulfill({json:{problemTypes:selectProblemOrders(rows,[],currentProblemClassifier()).problemTypes}}));
 await page.goto('/');await expect(page.locator('#order-rows tr')).toHaveCount(2);await expect(page.locator('#order-rows')).not.toContainText(invalidTemuQuantities);
 for(const row of rows){const tr=page.locator('#order-rows tr').filter({hasText:row.reference});await expect(tr).toContainText(cancelledTemuFulfillment);}
 const preserved=page.locator('#order-rows tr').filter({hasText:rows[1].reference});await expect(preserved).toContainText('stock insuffisant');
 await page.locator('.compact-problem').first().scrollIntoViewIfNeeded();await page.screenshot({path:'proofs/temu-cancelled-quantities-'+name+'.png',fullPage:false});expect(writes).toEqual([]);expect(errors).toEqual([]);
 fs.writeFileSync('proofs/temu-cancelled-quantities-'+name+'.json',JSON.stringify({status:'PASS',viewport,cases:2,confirmedCancellationVisible:true,independentStockIssuePreserved:true,writes,errors,scope:'Synthetic full UI; no production mutation'}));
});
