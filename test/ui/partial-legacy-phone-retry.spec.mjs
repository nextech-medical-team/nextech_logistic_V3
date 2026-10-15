import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('resume exact legacy phone refusal without creating another BL or changing the typed remainder '+name,async({page})=>{
 await page.setViewportSize(viewport);
 const order={id:'phone-parent',reference:'PARTIAL-PHONE-TEST',channel:'tender',recipient:'Synthetic recipient',address:{country:'FR',city:'Paris',postal:'75001'},source_payload:{},source_date:'14/10/26',sku_lines:[{sku:'A',quantity:450}],line_count:1,item_quantity:450,label_status:'partial',erp_status:'live_created',tracking_status:'not_shipped',partial_mode:true,carrier:'gls_pharma',document_count:0,erp_live:{bc:{id:'bc',label:'BC TEST',status:'active'}},partial_allocation:[{sku:'A',remaining:400,allocated:50}],erplain_tracking_bls:[{id:'bl',label:'BL TEST',status:'ready_to_ship'}],complete_order_documents:false};
 const delivery={id:'existing-delivery',order_id:order.id,status:'review',stage:'creating_label',bl:{id:'bl',label:'BL TEST'},carrier:'gls_pharma',weight_kg:12.7175,parcel_count:1,selection:[{sku:'A',quantity:50}],tracking:[],documents:0,environment:'production',error:'Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS'};
 const unknown={...delivery,id:'unknown-delivery',bl:{id:'unknown-bl',label:'BL UNKNOWN'},error:'Réponse transporteur à rapprocher'};
 let resumed=false;const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/partial/visible','/api/orders/processing'].includes(new URL(r.url()).pathname))writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at:new Date().toISOString(),rows:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[]}}));
 await page.route('**/api/partial/preview?*',r=>r.fulfill({json:{order,bc:order.erp_live.bc,stockHolds:[],lines:[{lineId:'line',sku:'A',ordered:450,fulfilled:50,remaining:400,available:2,stockUsable:2,reserved:0}]}}));
 await page.route('**/api/partial/list?*',r=>r.fulfill({json:{rows:[resumed?{...delivery,status:'ready',stage:'ready',error:null,tracking:['SYNTHETIC-TRACKING'],documents:1}:delivery,unknown]}}));
 await page.route('**/api/partial/retry',r=>{resumed=true;return r.fulfill({json:{ok:true,labelOnly:true,blId:'bl'}});});
 await page.goto('/');await page.getByRole('button',{name:'Préparer une nouvelle livraison',exact:true}).click();
 const dialog=page.locator('dialog.partial-quantity-dialog'),retry=dialog.locator('[data-partial-retry]');await expect(retry).toHaveCount(1);await expect(retry).toHaveAttribute('data-partial-retry','existing-delivery');
 const input=dialog.locator('[data-partial-line="line"]');await input.fill('1');await page.screenshot({path:'proofs/partial-legacy-phone-before-'+name+'.png',fullPage:true});await retry.click();
 await expect(dialog).toContainText('BL et étiquette prêts');await expect(dialog).toContainText('SYNTHETIC-TRACKING');await expect(dialog).toContainText('Réponse transporteur à rapprocher');await expect(dialog.locator('[data-partial-retry]')).toHaveCount(0);await expect(input).toHaveValue('1');
 await page.screenshot({path:'proofs/partial-legacy-phone-retry-'+name+'.png',fullPage:true});expect(writes).toEqual([{path:'/api/partial/retry',body:{id:'existing-delivery'}}]);expect(errors).toEqual([]);
});
