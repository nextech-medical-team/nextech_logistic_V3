import {test,expect} from '@playwright/test';
for(const width of [1366,390])test('order row opens the existing quote dialog without buying '+width,async({page})=>{
 await page.setViewportSize({width,height:900});
 const reference='PO-069-123456789',at=new Date().toISOString();
 const o={id:'direct',reference,channel:'temu',recipient:'Client fictif',address:{country:'FR'},source_payload:{origin:'temu_excel'},sku_lines:[],tracking_status:'not_shipped',erp_live_job:{status:'complete'},erp_live:{bc:{id:'bc',status:'active'},bl:{id:'bl',status:'ready_to_ship'},verifiedAt:at,stockCheckedAt:at},temu_job:{status:'to_buy'},carrier:'temu'};
 let bought=0,quoted=0;
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[o],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/temu/local',r=>r.fulfill({json:{rows:[{id:o.id,reference,status:'to_buy',direct:{state:'verified'},documents:[],packages:[]}]}}));
 await page.route('**/api/temu/status',r=>r.fulfill({json:{configured:true,purchaseEnabled:true}}));
 await page.route('**/api/temu/prepare',r=>{quoted++;return r.fulfill({json:{reference,id:'plan',amount:2.67,currency:'EUR',expiresAt:Date.now()+600000,selected:1,offers:[{channelId:1,shippingCompanyName:'GOFO'}]}});});
 await page.route('**/api/temu/buy',r=>{bought++;return r.fulfill({json:{status:'complete'}});});
 await page.goto('/');await page.locator('#order-rows').getByRole('button',{name:'Acheter l’étiquette',exact:true}).click();
 await expect(page.locator('#temu-purchase-dialog')).toBeVisible();await expect(page.locator('#temu-preview')).toContainText('2.67');
 expect(quoted).toBe(1);expect(bought).toBe(0);await expect(page.locator('#view-orders')).toBeVisible();
 await expect(page.locator('#temu-batch-buy')).toBeDisabled();
 await page.locator('#temu-batch-confirm').check();await page.locator('#temu-batch-buy').click();await expect.poll(()=>bought).toBe(1);
});
