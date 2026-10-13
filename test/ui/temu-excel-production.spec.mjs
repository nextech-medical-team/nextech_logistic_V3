import {test,expect} from '@playwright/test';
for(const width of [1366,390])test('Excel production preparation requires shop and confirmation at '+width+'px',async({page})=>{
 await page.setViewportSize({width,height:900});let prepared=false;const calls=[];
 await page.route('**/api/temu/excel/orders',route=>route.fulfill({json:{rows:[{id:'excel-test',reference:'PO-069-123456789',country:'HR',erp_live:prepared?{bl:{id:'bl',status:'ready_to_ship'}}:{},preparation:prepared?{mallId:'123'}:null}]}}));
 await page.route('**/api/temu/excel/preview?*',route=>route.fulfill({json:{reference:'PO-069-123456789',fingerprint:'verified-preview',commercial:{total:84.05,tax:16.8,currency:'EUR'},lines:[{sku:'SKU-TEST',quantity:5}],shops:[{mallId:'123',country:'HR'}]}}));
 await page.route('**/api/temu/excel/prepare',async route=>{calls.push(route.request().postDataJSON());prepared=true;await route.fulfill({json:{id:'excel-test',message:'Préparation BC/BL demandée dans Erplain.'}});});
 await page.goto('/');await expect(page.locator('#page-info')).toContainText('120 commandes');await page.waitForFunction(()=>!!document.querySelector('#temu-excel-preparation'));
 await page.evaluate(()=>show('imports'));const panel=page.locator('#temu-excel-preparation');
 await panel.getByRole('button',{name:'Vérifier et préparer'}).click();await expect(panel.locator('[data-preview]')).toContainText('84.05 EUR');
 const start=panel.getByRole('button',{name:'Lancer les BC/BL dans Erplain'});await expect(start).toBeDisabled();
 await panel.locator('[data-shop]').selectOption('123');await expect(start).toBeDisabled();expect(calls).toHaveLength(0);
 await panel.locator('[data-consent]').check();await expect(start).toBeEnabled();await start.click();
 await expect(panel.locator('[data-message]')).toContainText('Préparation BC/BL demandée');await expect(panel.getByRole('button',{name:'Étiquette et marge TEMU'})).toBeVisible();
 expect(calls).toEqual([{reference:'PO-069-123456789',mallId:'123',fingerprint:'verified-preview',confirmPreparation:true}]);
 await expect(panel.locator('[data-preview]')).toBeEmpty();
});
