import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('explicit Excel renewal shows old and seller amounts before queuing without a label purchase '+name,async({page})=>{
 await page.setViewportSize(viewport);let renewed=false;const writes=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/temu/'))writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 await page.route('**/api/temu/excel/orders',r=>r.fulfill({json:{rows:[{id:'old',reference:'PO-FIXTURE-RENEW',country:'NL',preparation:{jobId:'old'},revalidationAvailable:!renewed,erp_error:renewed?null:'Excel : prix ou articles modifiés depuis la validation',erp_status:renewed?'pending':'review'},{id:'documented',reference:'PO-FIXTURE-WITH-BL',country:'FR',preparation:{jobId:'original'},erp_live:{bl:{id:'existing',status:'ready_to_ship'}},revalidationAvailable:false}]}}));
 await page.route('**/api/temu/excel/preview?*',r=>{expect(new URL(r.request().url()).searchParams.get('renew')).toBe('1');return r.fulfill({json:{reference:'PO-FIXTURE-RENEW',renewal:true,fingerprint:'current-snapshot',previousCommercial:{total:4.30,currency:'EUR'},commercial:{total:8.66,tax:.75,currency:'EUR'},lines:[{sku:'6963_P1',quantity:1}]}});});
 await page.route('**/api/temu/excel/prepare',r=>{renewed=true;return r.fulfill({json:{jobId:'new',message:'Validation Excel renouvelée ; reprise demandée. Aucun achat effectué.'}});});
 await page.goto('/');await page.getByRole('button',{name:'Imports de fichiers',exact:true}).click();
 const panel=page.locator('#temu-excel-preparation');await expect(panel.locator('[data-renew]')).toHaveCount(1);await panel.locator('[data-renew]').click();
 const preview=panel.locator('[data-preview]');await expect(preview).toContainText('4.30 EUR → validation recalculée : 8.66 EUR');await expect(preview).toContainText('6963_P1 × 1');await expect(preview.locator('[data-start]')).toBeDisabled();expect(writes).toEqual([]);
 await page.screenshot({path:'proofs/temu-excel-renewal-preview-'+name+'.png',fullPage:true});
 await preview.locator('[data-consent]').check();await preview.locator('[data-start]').click();await expect(panel.locator('[data-message]')).toContainText('Aucun achat effectué');await expect(panel.locator('[data-renew]')).toHaveCount(0);
 await page.screenshot({path:'proofs/temu-excel-renewal-result-'+name+'.png',fullPage:true});
 expect(writes).toEqual([{path:'/api/temu/excel/prepare',body:{reference:'PO-FIXTURE-RENEW',fingerprint:'current-snapshot',confirmPreparation:true,confirmRenewal:true}}]);expect(errors).toEqual([]);
});
