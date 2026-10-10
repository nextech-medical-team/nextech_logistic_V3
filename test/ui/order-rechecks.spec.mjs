import {test,expect} from '@playwright/test';import fs from 'node:fs';
const at='2026-10-10T12:00:00Z',monitor={blocked:true,lastCheck:at,nextCheck:'2026-10-10T12:05:00Z',result:'Reprise historique : BL non cr\u00e9\u00e9',nextStep:'Rapprocher le BC et son d\u00e9bit existant, puis cr\u00e9er le BL manquant',alert:true};
const row={id:'test-recheck',reference:'TEST-RECHECK',channel:'temu',archived:false,simulation:false,recipient:'Synthetic recipient',address:{country:'FR',city:'Paris',postal:'75001'},source_date:at,line_count:1,item_quantity:20,sku_lines:[{sku:'TEST-SKU',quantity:20}],label_status:'production_ready',tracking_status:'not_shipped',carrier:'temu',source_payload:{},erp_live:{bc:{id:'TEST-BC',label:'BC TEST',status:'active'}}};
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('persistent order rechecks '+name,async({page})=>{
 await page.setViewportSize(viewport);const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/partial/visible','/api/orders/processing'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at,rows:[{id:row.id,monitoring:monitor}]}}));await page.goto('/');
 const card=page.locator('#order-rows .order-processing');await expect(card).toHaveCount(1);await expect(card.locator('.processing-stage')).toHaveText('Contr\u00f4le des blocages');
 for(const [cls,text]of [['monitoring-last','Derni\u00e8re v\u00e9rification'],['monitoring-next','Prochain contr\u00f4le'],['monitoring-result','R\u00e9sultat'],['monitoring-step','\u00c9tape suivante']])await expect(card.locator('.'+cls)).toContainText(text);
 await expect(card.locator('.monitoring-alert')).toContainText('Sans progression depuis plus d\u2019une heure');await card.scrollIntoViewIfNeeded();
 const bounds=await card.boundingBox();expect(bounds.width).toBeLessThan(viewport.width);const clipping=await card.evaluate(el=>[...el.children].some(c=>c.scrollWidth>el.clientWidth+2));expect(clipping).toBe(false);
 await page.screenshot({path:'proofs/order-rechecks-'+name+'.png',fullPage:false});expect(writes).toEqual([]);expect(errors).toEqual([]);
 fs.writeFileSync('proofs/order-rechecks-'+name+'.json',JSON.stringify({status:'PASS',viewport,fields:4,persistentAlert:true,writes,errors,bounds,clipping,scope:'Full application with synthetic order and processing responses'}));
});
