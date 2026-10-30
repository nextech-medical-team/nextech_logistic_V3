import {test,expect} from '@playwright/test';

for(const width of [1440,390])test('lot correction uses a supported BL resume action at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const error='BL · Lot de traçabilité Erplain · 20 100 78 : numéro de lot absent dans Erplain — création BL bloquée';
 const order={id:'batch-order',reference:'SYNTHETIC-BATCH',channel:'temu',carrier:'temu',recipient:'Client fictif',address:{country:'FR'},sku_lines:[{sku:'20 100 78',quantity:1,mapping_exists:true}],source_payload:{},erp_live:{bc:{id:1,status:'active'},phase:'bc_created'},label_status:'blocked',tracking_status:'not_shipped',document_count:0,erp_live_job:{status:'review',error}};
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/resolutions/context**',r=>r.fulfill({json:{order,lines:[{source_sku:'20 100 78',target_sku:'20 100 78',quantity:1}],erpJob:order.erp_live_job,products:[],active:null}}));
 const writes=[];
 await page.route('**/api/resolutions',r=>{writes.push(r.request().postDataJSON());return r.fulfill({status:202,json:{id:'batch-job'}});});
 await page.route('**/api/resolutions/job**',r=>r.fulfill({json:{id:'batch-job',action:'resume-erp',status:'complete',result:{resume:true,message:'BL préparé'}}}));
 await page.goto('/',{waitUntil:'domcontentloaded'});
 await page.locator('[data-problem-type="batch"]').first().click();
 const button=page.getByRole('button',{name:'Vérifier les lots et reprendre le BL',exact:true});
 await expect(button).toBeVisible();
 await expect(page.getByText('Action incompatible avec le problème sélectionné',{exact:true})).toHaveCount(0);
 await page.screenshot({path:'reports/batch-auto-resume-20261030/dialog-'+width+'.png',fullPage:true});
 await button.click();await expect.poll(()=>writes.length).toBe(1);
 expect(writes[0]).toMatchObject({id:order.id,action:'resume-erp',type:'batch'});
});
