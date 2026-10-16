import {test,expect} from '@playwright/test';
import {monitoringObservation} from '../../src/order-recheck-monitor.mjs';
const row={id:'audited-bc-test',reference:'TEST-BC-RECOVERY',channel:'temu',archived:false,recipient:'Client fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_date:'2026-10-16T08:00:00Z',sku_lines:[{sku:'TEST-SKU',source_sku:'TEST-SKU',quantity:60}],label_status:'blocked',tracking_status:'not_shipped',carrier:'temu',source_payload:{temuDirect:{status:4}},resolution_pending_resume:false,erp_live:{},erp_live_job:{status:'review',error:null},suspension:{}};
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('a stopped BC shows its actionable reason instead of generic prerequisites '+name,async({page})=>{
 await page.setViewportSize(viewport);const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{rows:[{id:row.id,currentCarrier:'temu',monitoring:monitoringObservation(row,{},Date.now())}]}}));
 await page.goto('/');await expect(page.locator('#order-rows .compact-problem').first()).toHaveText('BC non créé : reprise en attente');
 await expect(page.locator('#order-rows')).not.toContainText('prérequis non validés');await expect(page.locator('#order-rows')).not.toContainText('Blocage sans motif enregistré');
 await page.locator('[data-order-more-info]').first().click();await expect(page.locator('#order-rows .order-row-expanded .monitoring-result')).toContainText('traitement ERP arrêté sans motif actif');
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});
