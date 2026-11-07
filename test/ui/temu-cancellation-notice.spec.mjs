import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {platformIndicativeView} from '../../src/platform-indicative-view.mjs';
for(const [device,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
 test('TEMU cancellation message '+device,async({page})=>{
  const row={id:'notice-test',reference:'PO-TEST-CANCELLED',channel:'temu',recipient:'Destinataire test',address:{country:'FR'},source_date:'2026-11-06',label_status:'simulated',erp_status:'live_review',tracking_status:'not_shipped',carrier:'temu',weight_kg:1,sku_lines:[{sku:'TEST',source_sku:'TEST',quantity:1,mapping_exists:true}],erp_live:{bc:{id:'123',label:'C-TEST',status:'active'}},source_payload:{temuDirect:{status:3,verifiedAt:'2026-11-07T10:00:00Z'}}};
  row.platform_status=platformIndicativeView(row);const writes=[],errors=[];
  await page.setViewportSize(viewport);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
  await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
  await page.goto('/');if(device==='mobile')await page.getByRole('button',{name:'Déplier les informations de PO-TEST-CANCELLED'}).click();const notice=page.locator('[data-temu-cancellation-notice]');await expect(notice).toBeVisible();await expect(notice).toContainText('Annulation TEMU confirmée');await expect(notice).toContainText('BC C-TEST : annulation Erplain à vérifier');await notice.scrollIntoViewIfNeeded();
  const layout=await notice.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));expect(layout.scroll).toBeLessThanOrEqual(layout.width+1);
  fs.mkdirSync('proofs',{recursive:true});await page.screenshot({path:'proofs/temu-cancellation-notice-'+device+'.png'});expect(writes).toEqual([]);expect(errors).toEqual([]);
 });
}
