import {test,expect} from '@playwright/test';
const order=id=>({id,reference:'UI-'+id,channel:'tender',account_manager:'appels_offres',recipient:'Destinataire fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_date:'2026-10-13',source_payload:{},erp_live:{bc:{label:'BC-'+id,status:'active'}},document_count:0,label_status:'pending',tracking_status:'not_shipped',sku_lines:[{sku:'LONG-SKU-REFERENCE-TEST',quantity:3000,catalog_issue:'Stock insuffisant'}],line_count:1,item_quantity:3000,weight_kg:4.2,parcel_count:1,carrier:'gls_pharma',extra_parcels:[]});
async function fixture(page){let rows=[order('A'),order('B')],tick=0,partials=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:rows.map(o=>({...o,updated_at:String(++tick)})),total:rows.length,page:1,pages:1,summary:{total:rows.length,blocked:tick},transportStats:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:partials}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at:new Date().toISOString(),rows:rows.map(o=>({id:o.id,stage:'Préparation à corriger',state:'blocked',since:'2026-10-13T10:00:00Z',reason:'Stock insuffisant',canPrioritize:true}))}}));
 await page.route('**/api/equivalences/stock-information?*',r=>r.fulfill({json:{original:{incoming:10000},equivalents:[],equivalentCount:0,locationId:'TEST',checkedAt:'2026-10-14T10:00:00Z',expiresAt:'2099-01-01T00:00:00Z'}}));
 await page.goto('/');await expect(page.locator('[data-detail="A"]')).toBeVisible();await expect(page.locator('.order-processing').first()).toBeVisible();
 return {errors,change:()=>{rows[0]={...rows[0],document_count:1,label_status:'production_ready',carrier_job:{status:'ready',environment:'production',tracking:['TEST-TRACKING']}};},remove:()=>{rows=rows.slice(1);},partial:()=>{partials=[{id:'P',order_id:'A',reference:'UI-A',status:'ready',created_at:'2026-10-13T10:00:00Z',selection:[{sku:'TEST-SKU',quantity:1}],documents:0,tracking:[],address:{country:'FR'},erp_live:{},bl:{status:'ready_to_ship'},weight_kg:1,parcel_count:1,carrier:'gls'}];}};
}

test('unrendered source metadata does not replace visible rows or stock and processing controls',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const f=await fixture(page);await page.locator('[data-order-more-info]').first().click();await expect(page.locator('#order-information-dialog [data-stock-information]').first()).toContainText('10');await page.locator('#order-information-dialog [data-close-information]').click();await page.locator('[data-id="A"]').check();await page.evaluate(()=>{window.originalRow=document.querySelector('[data-detail="A"]').closest('tr');window.originalProcessing=originalRow.querySelector('.order-processing');window.originalStock=originalRow.querySelector('[data-stock-information]');window.removedOriginal=0;new MutationObserver(rs=>{for(const r of rs)for(const n of r.removedNodes)if(n===originalRow)removedOriginal++;}).observe(document.querySelector('#order-rows'),{childList:true});});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[{...order('A'),source_payload:{lastRead:new Date().toISOString()}},order('B')],total:2,page:1,pages:1,summary:{total:2},transportStats:[]}}));
 let revision=0;await page.route('**/api/erplain-refresh/diagnostics?*',r=>r.fulfill({json:{rows:[{id:'A',erplain_refresh:{checkedAt:String(++revision),issues:[]}}]}}));
 for(let i=0;i<5;i++)await page.evaluate(()=>refreshOrdersQuietly());expect(await page.evaluate(()=>removedOriginal)).toBe(0);expect(await page.evaluate(()=>originalProcessing===originalRow.querySelector('.order-processing'))).toBe(true);expect(await page.evaluate(()=>originalStock===originalRow.querySelector('[data-stock-information]'))).toBe(true);await expect(page.locator('[data-order-more-info]').first()).toBeVisible();await expect(page.locator('[data-id="A"]')).toBeChecked();expect(f.errors).toEqual([]);
 await page.screenshot({path:'../stable-1440.png',fullPage:false});await page.setViewportSize({width:390,height:1000});await page.screenshot({path:'../stable-390.png',fullPage:false});
});

for(const fails of [false,true])test('changed visible rows never paint without their processing block; read failure '+fails,async({page})=>{
 const f=await fixture(page);
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[{...order('A'),recipient:'Destinataire actualisé'},order('B')],total:2,page:1,pages:1,summary:{total:2},transportStats:[]}}));
 await page.route('**/api/orders/processing',async r=>{await new Promise(resolve=>setTimeout(resolve,250));await r.fulfill(fails?{status:503,json:{error:'Lecture temporairement indisponible'}}:{json:{at:new Date().toISOString(),rows:['A','B'].map(id=>({id,stage:'Préparation à corriger',state:'blocked',since:'2026-10-13T10:00:00Z',reason:'Stock insuffisant',canPrioritize:true}))}});});
 const observed=await page.evaluate(async()=>{let running=true;const frames=[];function sample(){const row=document.querySelector('[data-detail="A"]').closest('tr');frames.push({processing:!!row.querySelector('.order-processing'),height:row.getBoundingClientRect().height});if(running)requestAnimationFrame(sample);}requestAnimationFrame(sample);await refreshOrdersQuietly();await new Promise(resolve=>setTimeout(resolve,350));running=false;return frames;});
 expect(observed.length).toBeGreaterThan(0);expect(observed.every(frame=>frame.processing)).toBe(true);await expect(page.locator('#order-rows')).toContainText('Destinataire actualisé');
 if(fails)await expect(page.locator('.processing-position').first()).toContainText('non confirmé');expect(f.errors).toEqual([]);
});

test('a late processing response cannot replace a newer observation',async({page})=>{
 await fixture(page);let read=0;
 await page.route('**/api/orders/processing',async r=>{const current=++read;if(current===1)await new Promise(resolve=>setTimeout(resolve,200));await r.fulfill({json:{at:new Date().toISOString(),rows:['A','B'].map(id=>({id,stage:current===1?'Ancien état':'État récent',state:'blocked',since:'2026-10-13T10:00:00Z'}))}});});
 await page.evaluate(async()=>{const old=window.V3OrderProcessing.read(['A','B']);await new Promise(resolve=>setTimeout(resolve,30));window.V3OrderProcessing.acceptSnapshot(await window.V3OrderProcessing.read(['A','B']));window.V3OrderProcessing.acceptSnapshot(await old);});
 await expect(page.locator('.processing-stage').first()).toHaveText('État récent');
});
