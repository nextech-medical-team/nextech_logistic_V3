import {test,expect} from '@playwright/test';

for(const width of [1440,390])test('recovered BL label targets the pending delivery at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const first={id:'101',label:'SHO00000101',status:'delivered',line_items:[{variant:{sku:'FIRST'},quantity:1}]};
 const second={id:'102',label:'SHO00000102',status:'pending',line_items:[{variant:{sku:'SECOND'},quantity:2}]};
 const order={id:'recovered-order',reference:'SYNTHETIC-RECOVERY',channel:'amazon',account_manager:'amazon',recipient:'Client fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_payload:{},erp_live:{bc:{id:'100',label:'C00000100',status:'active',shipping_orders:{data:[first,second]}},bl:first},document_count:1,label_status:'production_ready',tracking_status:'delivered',sku_lines:[{sku:'SECOND',quantity:2}],line_count:1,item_quantity:2,weight_kg:1,parcel_count:1,carrier:'gls',carrier_job:{status:'ready',environment:'production',tracking:['OLD-TRACK']},extra_parcels:[]};
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{total:1},transportStats:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[]}}));
 const requests=[];
 await page.route('**/api/partial/existing-bl-label',async r=>{requests.push(r.request().postDataJSON());await r.fulfill({status:202,json:{id:'new-delivery',status:'bl_ready',existing:false}});});
 await page.goto('/');
 const button=page.locator('[data-existing-bl-label="102"]');
 await expect(page.locator('[data-existing-bl-label="101"]')).toHaveCount(0);
 await page.getByText('2 BL associé(s)',{exact:true}).click();
 await expect(button).toBeVisible();await button.click();
 await expect.poll(()=>requests.length).toBe(1);
 expect(requests[0]).toEqual({id:order.id,blId:'102',requestId:expect.stringMatching(/^[a-f0-9-]{36}$/i)});
 await expect(page.locator('[data-detail="recovered-order"]')).toBeVisible();
 await page.screenshot({path:'proofs/recovered-bl-label-'+width+'.png',fullPage:true});
});
