import {test,expect} from '@playwright/test';import fs from 'node:fs';
import {processingView} from '../../src/order-priority.mjs';
import {monitoringObservation} from '../../src/order-recheck-monitor.mjs';
const at=new Date().toISOString();
const cases=[
 {id:'synthetic-confirm',temu_job:{status:'ready'},erp_live_job:{status:'complete'},erp_live:{phase:'bl_ready',bc:{id:'1'},bl:{id:'2'}}},
 {id:'synthetic-refused',temu_job:{status:'shipment_error',error:'TEMU · Étiquette refusée : adresse non anglaise'},erp_live_job:{status:'complete'},erp_live:{phase:'bl_ready',bc:{id:'1'},bl:{id:'2'}}},
 {id:'synthetic-waiting',erp_live_job:{status:'pending'},erp_live:{}},
 {id:'synthetic-resume',erp_live_job:{status:'review'},erp_live:{phase:'bc_created',bc:{id:'1'}}}
].map((c,i)=>({...c,reference:'TEST-PREPARATION-'+i,channel:'temu',archived:false,simulation:false,recipient:'Synthetic order',address:{country:'FR',city:'Paris',postal:'75001'},source_date:at,line_count:1,item_quantity:1,sku_lines:[{sku:'TEST-SKU',quantity:1}],label_status:'blocked',tracking_status:'not_shipped',carrier:'temu',source_payload:{},resolution_error:'Préparation bloquée : vérification à reprendre'}));
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('precise preparation and TEMU stages '+name,async({page})=>{
 await page.setViewportSize(viewport);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const rows=cases.map(o=>({...o,resolution_error:monitoringObservation(o).result}));
 const progress=cases.map(o=>({...processingView({id:o.id,phase:o.erp_live.phase,erp_status:o.erp_live_job.status,erp_error:o.erp_live_job.error,erp_position:o.erp_live_job.status==='pending'?1:null,temu_status:o.temu_job?.status,temu_error:o.temu_job?.error}),monitoring:monitoringObservation(o)}));
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows,total:4,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at,rows:progress}}));
 await page.goto('/');const cards=page.locator('#order-rows .order-processing');await expect(cards).toHaveCount(4);
 const labels=['Achat d’étiquette TEMU à confirmer','Étiquette refusée par TEMU','Préparation Erplain en attente de traitement','BL Erplain restant à préparer'];
 for(let i=0;i<4;i++){await expect(cards.nth(i).locator('.processing-stage')).toContainText(labels[i]);await page.locator('#order-rows [data-order-more-info]').nth(i).click();const full=page.locator('#order-rows .order-row-expanded .order-processing');await expect(full.locator('.monitoring-step')).toBeHidden();const overflow=await full.evaluate(el=>el.scrollWidth>el.clientWidth+2);expect(overflow).toBe(false);await page.locator('#order-rows .order-row-expanded [data-order-more-info]').click();}
 await expect(page.locator('#order-rows')).not.toContainText('Préparation bloquée');expect(errors).toEqual([]);
 await page.screenshot({path:'proofs/preparation-temu-policy-'+name+'.png',fullPage:true});
 fs.writeFileSync('proofs/preparation-temu-policy-'+name+'.json',JSON.stringify({status:'PASS',viewport,labels,orders:4,genericMessages:0,errors,providerWrites:0,scope:'Synthetic isolated application'}));
});

