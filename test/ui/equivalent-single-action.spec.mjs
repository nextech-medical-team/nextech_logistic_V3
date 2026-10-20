import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('one submission applies equivalent and follows continuation '+name,async({page})=>{
 const writes=[];await page.setViewportSize(viewport);
 const row={id:'single',reference:'SYNTHETIC-SINGLE',channel:'temu',carrier:'temu',recipient:'Synthetic',address:{country:'IE'},sku_lines:[{sku:'A',quantity:1,mapping_exists:true}],source_payload:{},erp_live:{bc:{id:1,status:'active'},phase:'bc_created'},label_status:'pending',tracking_status:'not_shipped',document_count:0,pending_equivalent:{sku:'A',replacementSku:'B',replaceQuantity:1,replacementQuantity:1,scope:'order',previewJobId:'old',error:'Produit équivalent vérifié : confirmer le remplacement'},erp_live_job:{status:'review',error:'Stock insuffisant : A'}};
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/resolutions/context**',r=>r.fulfill({json:{order:row,lines:[{source_sku:'A',target_sku:'A',quantity:1,target_quantity:1}],erpJob:row.erp_live_job,products:[],active:null}}));
 await page.route('**/api/resolutions',r=>{writes.push(r.request().postDataJSON());return r.fulfill({status:202,json:{id:'single-job'}});});
 await page.route('**/api/resolutions/job**',r=>r.fulfill({json:{id:'single-job',action:'replace-equivalent',status:'complete',result:{equivalent:true,message:'Remplacement enregistré et préparation poursuivie'}}}));
 await page.goto('/',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'B Appliquer le remplacement',exact:true}).click();
 await expect(page.locator('[name="replacementSku"]')).toHaveValue('B');
 expect(writes).toHaveLength(0);
 await page.locator('form:has([name="replacementSku"])').evaluate(f=>{f.requestSubmit();f.requestSubmit();});
 await expect.poll(()=>writes.length,{timeout:20000}).toBe(1);
 await expect(page.getByText('Remplacement enregistré et préparation poursuivie',{exact:false}).first()).toBeVisible({timeout:20000});
 expect(writes[0]).toMatchObject({action:'replace-equivalent',verifyAndApply:true,confirmEquivalent:true,scope:'order',sku:'A',replacementSku:'B',replaceQuantity:1,replacementQuantity:1});
 expect(writes[0].previewFingerprint).toBeUndefined();await expect(page.getByRole('button',{name:'Abandonner l’équivalent',exact:true})).toBeHidden();
 await page.screenshot({path:'proofs/equivalent-single-action-'+name+'.png'});
});
