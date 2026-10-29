import {test,expect} from '@playwright/test';

for(const width of [1440,390])test('order recovery shows automatic label admission at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/api/erplain-refresh/recovered-orders?**',r=>r.fulfill({json:{rows:[],total:0,page:1,pages:1}}));
 const message='1 étiquette(s) de BL récupéré mise(s) en génération.';
 const result={orderId:'recovered',alreadyRecovered:true,readAt:'2026-10-26T10:00:00Z',document:{id:'100',label:'BC-100',line_items:[],shipping_orders:{data:[{id:'101',label:'BL-101',status:'delivered'},{id:'102',label:'BL-102',status:'pending'}]}},labelRecovery:{labels:[{blId:'102',status:'bl_ready'}],labelHolds:[],message}};
 let requests=0;
 await page.route('**/api/erplain-refresh/targeted-lookup',async r=>{requests++;expect(r.request().postDataJSON()).toEqual({reference:'BC-100'});await r.fulfill({json:result});});
 await page.goto('/');
 await page.getByRole('button',{name:'Commandes Erplain LIVE',exact:true}).click();
 await page.locator('#erplain-one-reference').fill('BC-100');
 await page.getByRole('button',{name:'Récupérer cette commande depuis Erplain',exact:true}).click();
 await expect(page.locator('#erplain-one-note')).toHaveText(message);
 await expect(page.locator('#erplain-one-preview [role="status"]')).toHaveText(message);
 expect(requests).toBe(1);
 await expect(page.locator('#erplain-one-preview')).toContainText('BL-102');
});
