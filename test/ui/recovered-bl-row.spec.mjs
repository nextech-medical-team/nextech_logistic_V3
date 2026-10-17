import {test,expect} from '@playwright/test';
test('recovered Amazon BL has one operational row and normal batch button targets only its label',async({page})=>{
 const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const first={id:'first',label:'SH-FIRST',status:'delivered',line_items:[{variant:{sku:'165674'},quantity:14}]};
 const bl={id:'second',label:'SH-SECOND',status:'pending',line_items:[{variant:{sku:'165674'},quantity:42}]};
 const o={id:'o',reference:'404-TEST',channel:'amazon',recipient:'Client test',address:{country:'FR',city:'Grenoble',postal:'38100',street:'1 rue Test'},source_date:'04/10/26',received_at:'2026-10-04T10:00:00Z',partial_mode:true,source_payload:{archivedBlRecovery:{deliveryId:'d',blId:'second'}},erp_live:{bc:{id:'bc',label:'C-TEST',status:'active',shipping_orders:{data:[first,bl]}},documentSource:{lines:[{sku:'165674',quantity:56}],shippingOrders:[first,bl]}},sku_lines:[{sku:'165674',quantity:56}],tracking_status:'not_shipped',label_status:'partial',erp_status:'partial_pending',invoice_status:'not_due'};
 const d={id:'d',order_id:'o',reference:o.reference,recipient:o.recipient,address:o.address,erp_live:o.erp_live,created_at:'2026-10-17T10:00:00Z',status:'review',stage:'recovered_bl',selection:[{sku:'165674',quantity:42}],bl,tracking:[],documents:0,label_choice:'new',environment:'production'};
 await page.route('**/api/orders?*',r=>r.fulfill({json:{rows:[o],total:1,page:1,pages:1,summary:{total:1,labels:0,blocked:0},transportStats:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[d]}}));
 await page.route('**/api/partial/retry',r=>{calls.push(r.request().postDataJSON());return r.fulfill({json:{labelOnly:true}});});
 await page.route('**/api/carriers/labels',r=>{calls.push({WRONG:r.request().postDataJSON()});return r.fulfill({json:{message:'wrong'}});});
 await page.goto('/');await page.locator('button[data-view="orders"]').first().click();
 const rows=page.locator('#order-rows > tr');await expect(rows).toHaveCount(1);await expect(rows).toContainText('165674 (42)');
 await expect(rows.locator('[data-prepare-partial]')).toHaveCount(0);await expect(rows.locator('[data-recovered-label]')).toBeVisible();
 await expect(rows).toContainText('SH-FIRST');await expect(rows).toContainText('SH-SECOND');
 await page.locator('[data-id="o"]').check();await page.locator('#sandbox-labels').click();await expect.poll(()=>calls.length).toBe(1);expect(calls).toEqual([{id:'d'}]);
 await expect(rows).toHaveCount(1);await expect(rows).toContainText('165674 (42)');
 await rows.locator('[data-recovered-label]').click();await expect.poll(()=>calls.length).toBe(2);expect(calls).toEqual([{id:'d'},{id:'d'}]);expect(errors).toEqual([]);
 d.status='ready';d.documents=1;d.tracking=['TRACK-42'];d.carrier='gls';d.weight_kg=21;d.parcel_count=1;
 await page.locator('#reload').click();await expect(rows).toHaveCount(1);await expect(rows.locator('[data-recovered-label]')).toHaveCount(0);await expect(rows.locator('a[href="/api/partial/documents/d/0"]')).toHaveCount(1);await expect(rows).toContainText('TRACK-42');
 await page.locator('[data-id="o"]').check();await page.locator('#download-all-labels').click();await expect(page.getByRole('dialog',{name:'Étiquettes de la sélection'})).toContainText('0 commande(s), 1 livraison(s)');

});
