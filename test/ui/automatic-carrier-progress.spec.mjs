import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {monitoringObservation} from '../../src/order-recheck-monitor.mjs';
const row={id:'auto-label-test',reference:'AUTO-LABEL-TEST',channel:'shopify',archived:false,recipient:'Client fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_date:'2026-10-13T08:00:00Z',line_count:1,item_quantity:1,sku_lines:[{sku:'TEST-SKU',quantity:1}],label_status:'simulated',tracking_status:'not_shipped',carrier:'gls_shop',source_payload:{},resolution_pending_resume:true,erp_live:{phase:'bl_ready',bc:{id:'TEST-BC',status:'active'},bl:{id:'TEST-BL',status:'ready_to_ship'}}};
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('automatic carrier diagnosis and progression '+name,async({page})=>{
 await page.setViewportSize(viewport);let monitor=monitoringObservation(row,{},Date.now());const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{rows:[{id:row.id,currentCarrier:'gls_shop',monitoring:monitor}]}}));await page.goto('/');
 const card=page.locator('#order-rows .order-processing');await expect(card.locator('.monitoring-result')).toContainText('verrou de reprise');
 for(const [status,text] of [['pending','worker'],['creating','cours'],['awaiting_pdf','PDF']]){monitor=monitoringObservation({...row,resolution_pending_resume:false,label_status:'production_pending',carrier_job:{status}},monitor,Date.now());await page.reload();await expect(card.locator('.monitoring-result')).toContainText(text);}
 monitor={...monitor,alert:true,externalOverdue:true,externalStatus:'partial',externalResult:'Contrôles ciblés partiels : budget de lectures BC/BL atteint'};await page.reload();await expect(card.locator('.monitoring-alert')).toContainText('budget de lectures BC/BL');
 await card.locator('.processing-details-toggle').click();await card.scrollIntoViewIfNeeded();const clipping=await card.evaluate(el=>[...el.children].some(c=>c.scrollWidth>el.clientWidth+2));expect(clipping).toBe(false);expect(errors).toEqual([]);
 fs.mkdirSync('proofs',{recursive:true});await page.screenshot({path:'proofs/automatic-carrier-'+name+'.png',fullPage:false});fs.writeFileSync('proofs/automatic-carrier-'+name+'.json',JSON.stringify({status:'PASS',viewport,stages:['resume_hold','pending','creating','awaiting_pdf'],externalBudgetShown:true,clipping,errors,scope:'Application complète, données fictives, aucun appel fournisseur'}));
});
