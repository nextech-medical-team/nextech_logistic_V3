import {test,expect} from '@playwright/test';
import fs from 'node:fs';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('BL direct label '+name,async({page})=>{
 const row={id:'direct',reference:'SYNTHETIC-BL-LABEL',channel:'amazon',carrier:'gofo',recipient:'Synthetic',address:{country:'FR'},sku_lines:[],source_payload:{},erp_live:{bl:{id:1902751,label:'SHO00743803',status:'ready_to_ship'},bc:{id:1,status:'active'},pricing:{status:'blocked'}},label_status:'simulated',tracking_status:'not_shipped',resolution_pending_resume:true,erp_live_job:{status:'review',error:'BC · Base fiscale des prix Erplain différente ou absente'},carrier_job:{status:'failed',error:'Préparation modifiée depuis la validation du BL'},document_count:0};
 const requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize(viewport);
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/carriers/from-bl',async r=>{requests.push(r.request().postDataJSON());await r.fulfill({status:202,json:{id:'direct',status:'pending'}});});
 await page.route('**/api/resolutions',r=>{requests.push({unexpected:'resolution'});return r.fulfill({status:500,json:{error:'No preparation expected'}});});
 await page.goto('/');const button=page.getByRole('button',{name:'Générer l’étiquette',exact:true});await expect(button).toHaveCount(1);await button.scrollIntoViewIfNeeded();
 await page.screenshot({path:'proofs/direct-label-'+name+'.png'});await button.click();await expect.poll(()=>requests.length).toBe(1);expect(requests).toEqual([{id:'direct'}]);expect(errors).toEqual([]);
 fs.writeFileSync('proofs/direct-label-'+name+'.json',JSON.stringify({status:'PASS',viewport,requests,errors,scope:'Synthetic full UI; direct endpoint only, no provider call'}));
});
test('existing selected-label toolbar uses the direct BL admission',async({page})=>{
 const requests=[];await page.route('**/api/carriers/labels',r=>{requests.push(r.request().postDataJSON());return r.fulfill({status:202,json:{queued:1,skipped:[],message:'Étiquette mise en génération'}});});
 await page.goto('/');const checkbox=page.locator('#order-rows input[data-id]').first();await checkbox.check();await page.getByRole('button',{name:'Créer les étiquettes transporteurs PROD',exact:true}).click();await expect.poll(()=>requests.length).toBe(1);expect(requests[0].ids).toHaveLength(1);
});
