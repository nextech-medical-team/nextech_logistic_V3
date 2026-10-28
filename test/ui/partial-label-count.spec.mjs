import {test,expect} from '@playwright/test';
import fs from 'node:fs';
for(const width of [1440,390])test('modify labels on the selected BL at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const order={id:'synthetic-order',reference:'TEST-LABELS',channel:'tender',recipient:'Client fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_payload:{},partial_mode:true,erp_live:{bc:{id:'100',label:'BC-TEST',status:'active'}},document_count:0,label_status:'ready',tracking_status:'not_shipped',sku_lines:[{sku:'TEST-SKU',quantity:2}],line_count:1,item_quantity:2,weight_kg:60,parcel_count:3,carrier:'gls_pharma',extra_parcels:[]};
 const d={id:'synthetic-delivery',order_id:order.id,reference:order.reference,status:'ready',environment:'production',carrier:'gls_pharma',weight_kg:60,parcel_count:3,tracking:['TEST1','TEST2','TEST3'],bl:{id:'101',label:'BL-TEST',status:'in_preparation'},selection:[{sku:'TEST-SKU',quantity:2}],documents:3,extra_parcels:[],created_at:'2026-10-28T10:00:00Z',erp_live:order.erp_live,address:order.address};
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{total:1},transportStats:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[d]}}));
 const requests=[];await page.route('**/api/partial/parcels/add',async r=>{requests.push(r.request().postDataJSON());await r.fulfill({status:202,json:{total:4}});});
 await page.goto('/');
 const row=page.locator('.delivery-row');const button=row.locator('[data-partial-count-edit]');
 if(width<900){const more=row.locator('[data-order-more-info]');if(await more.count())await more.click();}
 await button.scrollIntoViewIfNeeded();await expect(button).toBeVisible();await button.click();
 const input=row.getByRole('spinbutton',{name:'Nombre total d’étiquettes pour le BL BL-TEST'});await expect(input).toHaveValue('3');await input.fill('4');
 await page.screenshot({path:'/tmp/nextech-label-deploy/'+(width===1440?'desktop':'mobile')+'.png',fullPage:false});
 await row.getByRole('button',{name:'Valider',exact:true}).click();await expect.poll(()=>requests.length).toBe(1);
 expect(requests[0]).toEqual({deliveryId:d.id,expectedTotal:3,total:4,requestId:expect.stringMatching(/^[a-f0-9-]{36}$/i)});
 const metrics=await (await page.request.get('/test-metrics')).json();fs.writeFileSync('/tmp/nextech-label-deploy/performance-'+width+'.json',JSON.stringify(metrics));
});
