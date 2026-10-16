import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {projectCurrentDiagnostics} from '../../src/current-order-diagnostics.mjs';
import {processingView} from '../../src/order-priority.mjs';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('persisted manual GLS request stays acknowledged after refresh '+name,async({page})=>{
 let status='queued';const writes=[],errors=[];
 const view=()=>projectCurrentDiagnostics({id:'manual-request',reference:'TEST-MANUAL-GLS-REQUEST',channel:'temu',carrier:'temu',recipient:'Synthetic recipient',address:{country:'PL'},source_date:'2026-10-15',sku_lines:[],source_payload:{},label_status:'blocked',tracking_status:'unknown',erp_live:{bl:{id:'BL',status:'ready_to_ship'}},resolution_active:{id:'request',action:'choose-carrier',carrier:'gls',status,created_at:'2026-10-15T11:14:54Z',updated_at:'2026-10-15T11:14:54Z'},temu_job:{status:'shipment_error',error:'TEMU · Étiquette refusée : ancien essai',state_since:'2026-10-15T10:49:49Z'}});
 await page.setViewportSize(viewport);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[view()],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/order-problem-types*',r=>r.fulfill({json:{problemTypes:[]}}));
 await page.route('**/api/orders/processing',r=>{const o=view();return r.fulfill({json:{rows:[{...processingView({id:o.id,carrier:'temu',manual_label_request:o.manual_label_request,temu_status:'shipment_error',temu_error:null}),manual_label_request:o.manual_label_request,previous_temu_label_refusal:o.previous_temu_label_refusal,monitoring:{blocked:true,result:o.previous_temu_label_refusal.reason,nextStep:'Corriger TEMU',alert:true}}]}});});
 await page.goto('/');const badge=page.locator('.manual-label-request');await expect(badge).toHaveText('Demande GLS reçue · en attente de traitement');await expect(page.locator('.compact-problem')).toHaveCount(0);
 await expect(page.locator('#order-rows')).toContainText('Reçue le');await expect(page.locator('.monitoring-result')).toContainText('Ancien refus conservé');await expect(page.locator('.monitoring-step')).toContainText('Demande GLS reçue');
 await expect(page.locator('.previous-temu-label-refusal')).toHaveCount(1);await page.reload();await expect(badge).toHaveText('Demande GLS reçue · en attente de traitement');
 status='running';await page.reload();await expect(badge).toHaveText('Demande GLS en cours de traitement');await expect(badge).not.toContainText('disponible');
 expect(writes).toEqual([]);expect(errors).toEqual([]);fs.mkdirSync('proofs',{recursive:true});await page.screenshot({path:'proofs/manual-label-request-'+name+'.png',fullPage:false});fs.writeFileSync('proofs/manual-label-request-'+name+'.json',JSON.stringify({status:'PASS',viewport,writes,errors,scope:'Full application with persisted synthetic human request; no business calls'}));
});
