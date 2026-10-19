import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('Partial TEMU quote, explicit purchase and ready BL visible '+name,async({page})=>{
 await page.setViewportSize(viewport);const order={id:'temu-parent',reference:'PO-100-200',channel:'temu',recipient:'Synthetic recipient',address:{country:'SI',city:'Synthetic',postal:'1000'},source_payload:{},source_date:'15/10/26',sku_lines:[{sku:'A',quantity:1},{sku:'B',quantity:1}],line_count:2,item_quantity:2,label_status:'pending',erp_status:'live_created',tracking_status:'unknown',partial_mode:true,carrier:'temu',document_count:0,erp_live:{bc:{id:'10',label:'BC TEST',status:'active',line_items:[{id:'a',quantity:1,variant:{id:'60',sku:'A'}},{id:'b',quantity:1,variant:{id:'61',sku:'B'}}]}},partial_allocation:[{sku:'A',remaining:1,allocated:0},{sku:'B',remaining:1,allocated:0}]};
 let prepared=false;const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/partial/visible','/api/orders/processing'].includes(new URL(r.url()).pathname))writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order],total:1,page:1,pages:1,summary:{},transportStats:[]}}));await page.route('**/api/orders/processing',r=>r.fulfill({json:{rows:[]}}));await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[]}}));
 await page.route('**/api/partial/preview?*',r=>r.fulfill({json:{order,bc:order.erp_live.bc,stockHolds:[],lines:[{lineId:'a',sku:'A',variantId:'60',locationId:'70',ordered:1,fulfilled:0,remaining:1,available:0,stockUsable:0,tracked:true},{lineId:'b',sku:'B',variantId:'61',locationId:'70',ordered:1,fulfilled:0,remaining:1,available:1,stockUsable:4,tracked:true}]}}));
 await page.route('**/api/partial/list?*',r=>r.fulfill({json:{rows:prepared?[{id:'d',order_id:order.id,status:'bl_only',stage:'bl_only',label_choice:'bl_only_temu',carrier:'temu',bl:{id:'30',label:'SHO00000030',status:'pending'},selection:[{sku:'B',quantity:1}],tracking:[],documents:0,environment:'production'}]:[]}}));
 await page.route('**/api/partial/prepare',r=>{prepared=true;return r.fulfill({json:{id:'d'}});});
 let bought=false;const delivery=()=>({id:'d',order_id:order.id,reference:order.reference,status:bought?'ready':'temu_confirm',stage:'temu_label',label_choice:'bl_only_temu',carrier:'temu',bl:{id:'30',label:'SHO00000030',status:'ready_to_ship'},selection:[{sku:'B',quantity:1}],tracking:bought?['TRACK']:[],documents:bought?1:0,environment:'production',temu_label:{plan:bought?null:{id:'plan',amount:2.4,currency:'EUR',carrier:'TEMU Partner',expiresAt:Date.now()+600000}}});
 await page.route('**/api/partial/list?*',r=>r.fulfill({json:{rows:[delivery()]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:[{...delivery(),erp_live:order.erp_live,recipient:order.recipient,address:order.address,created_at:new Date().toISOString()}]}}));
 await page.route('**/api/partial/temu/buy',r=>{expect(r.request().postDataJSON()).toEqual({id:'d',planId:'plan',amount:2.4,confirmPurchase:true});bought=true;return r.fulfill({json:{status:'ready'}});});
 // A slow stock read for a new BL must never hide an existing BL's label.
 await page.route('**/api/partial/preview?*',()=>{});
 await page.goto('/',{waitUntil:'domcontentloaded'});
 await expect(page.locator('.delivery-row')).toContainText('Étiquette TEMU · achat à confirmer');
 await expect(page.locator('.delivery-row')).toContainText('Prêt à livrer');
 await expect(page.locator('.delivery-row').getByRole('button',{name:'Acheter l’étiquette TEMU · 2.4 EUR',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Préparer une nouvelle livraison',exact:true}).click();const dialog=page.locator('dialog.partial-quantity-dialog');
 await expect(dialog).toContainText('Le BL partiel sera créé');await expect(dialog).toContainText('TEMU Partner · 2.4 EUR');
 await dialog.locator('#partial-history').screenshot({path:'proofs/partial-temu-quote-'+name+'.png'});
 page.once('dialog',d=>d.accept());await dialog.getByRole('button',{name:'Acheter l’étiquette TEMU · 2.4 EUR',exact:true}).click();
 await expect(dialog).toContainText('BL et étiquette prêts');await expect(dialog).toContainText('TRACK');await expect(dialog.getByRole('link',{name:'PDF PROD 1',exact:true})).toBeVisible();
 await expect(dialog.locator('[data-partial-temu-buy]')).toHaveCount(0);expect(writes.filter(w=>w.path==='/api/partial/temu/buy')).toHaveLength(1);expect(errors).toEqual([]);
 await dialog.locator('#partial-history').screenshot({path:'proofs/partial-temu-ready-'+name+'.png'});
});
