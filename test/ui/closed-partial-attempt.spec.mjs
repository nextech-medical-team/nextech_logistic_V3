import {test,expect} from '@playwright/test';
import fs from 'node:fs';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('closed uncreated attempt remains neutral and real cancellation stays red '+name,async({page})=>{
 await page.setViewportSize(viewport);
 const order={id:'closed-test',reference:'TEST-CLOSED',channel:'tender',recipient:'Synthetic recipient',address:{country:'FR',city:'Paris'},source_date:'2026-10-21',source_payload:{},sku_lines:[{sku:'SKU-TEST',quantity:100}],partial_mode:true,label_status:'partial',erp_status:'partial',tracking_status:'not_shipped',erp_live:{bc:{id:'bc',label:'BC-TEST',status:'active'}},partial_allocation:[{sku:'SKU-TEST',remaining:100,allocated:0}]};
 const closed={id:'closed-attempt',order_id:order.id,reference:order.reference,erp_live:order.erp_live,recipient:order.recipient,address:order.address,status:'cancelled',stage:'cancelled',bl:null,documents:0,tracking:[],selection:[{sku:'SKU-TEST',quantity:100}],created_at:'2026-10-21T10:00:00Z',error:'Tentative locale non créée clôturée après rapprochement du stock ; quantités à sélectionner de nouveau.'};
 const actual={...closed,id:'actual-cancel',bl:{id:'BL',label:'SHO-TEST',status:'cancelled'},error:'BL annulé par opérateur',documents:1,tracking:['TRACK-TEST'],environment:'production'};
 const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{rows:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[closed,actual]}}));
 await page.goto('/');
 const row=page.locator('tr.delivery-row').filter({has:page.locator('[data-delivery-select="closed-attempt"]')});
 await expect(row).toContainText('Préparation clôturée — aucun BL créé');await expect(row).not.toHaveClass(/order-cancelled/);await expect(row).not.toContainText('BL annulé');await expect(row).not.toContainText('Statut à actualiser');await expect(row).toContainText('Sans expédition');await expect(row.locator('[data-erplain-document-kind="bl"]')).toHaveCount(0);await expect(row.locator('[data-delivery-select]')).toBeDisabled();
 const cancelled=page.locator('tr.delivery-row').filter({has:page.locator('[data-delivery-select="actual-cancel"]')});await expect(cancelled).toHaveClass(/order-cancelled/);await expect(cancelled).toContainText('BL annulé — ancienne étiquette conservée');await expect(cancelled.locator('a.pdf-link')).toHaveCount(1);
 expect(errors).toEqual([]);expect(writes).toEqual([]);fs.mkdirSync('proofs',{recursive:true});await row.scrollIntoViewIfNeeded();await page.screenshot({path:'proofs/closed-preparation-'+name+'.png'});
});
