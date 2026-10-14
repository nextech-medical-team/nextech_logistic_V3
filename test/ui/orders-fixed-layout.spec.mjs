import fs from 'node:fs';
import {test,expect} from '@playwright/test';
const order=id=>({id,reference:'UI-'+id,channel:'tender',account_manager:'appels_offres',recipient:'Destinataire fictif',address:{country:'FR',city:'Paris',postal:'75001'},source_date:'2026-10-13',source_payload:{},erp_live:{bc:{label:'BC-'+id,status:'active'}},document_count:0,label_status:'pending',tracking_status:'not_shipped',sku_lines:[{sku:'LONG-SKU-REFERENCE-TEST',quantity:3000,catalog_issue:'Stock insuffisant'}],line_count:1,item_quantity:3000,weight_kg:4.2,parcel_count:1,carrier:'gls_pharma',extra_parcels:[]});
async function fixture(page){let rows=[order('A'),order('B')],tick=0,partials=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:rows.map(o=>({...o,updated_at:String(++tick)})),total:rows.length,page:1,pages:1,summary:{total:rows.length,blocked:tick},transportStats:[]}}));
 await page.route('**/api/partial/visible',r=>r.fulfill({json:{rows:partials}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at:new Date().toISOString(),rows:rows.map(o=>({id:o.id,stage:'Préparation à corriger',state:'blocked',since:'2026-10-13T10:00:00Z',reason:'Stock insuffisant',canPrioritize:true}))}}));
 await page.route('**/api/equivalences/stock-information?*',r=>r.fulfill({json:{original:{incoming:10000},equivalents:[],equivalentCount:0,locationId:'TEST',checkedAt:'2026-10-14T10:00:00Z',expiresAt:'2099-01-01T00:00:00Z'}}));
 await page.goto('/');await expect(page.locator('[data-detail="A"]')).toBeVisible();await expect(page.locator('.order-processing').first()).toBeVisible();
 return {errors,change:()=>{rows[0]={...rows[0],document_count:1,label_status:'production_ready',carrier_job:{status:'ready',environment:'production',tracking:['TEST-TRACKING']}};},remove:()=>{rows=rows.slice(1);},partial:()=>{partials=[{id:'P',order_id:'A',reference:'UI-A',status:'ready',created_at:'2026-10-13T10:00:00Z',selection:[{sku:'TEST-SKU',quantity:1}],documents:0,tracking:[],address:{country:'FR'},erp_live:{},bl:{status:'ready_to_ship'},weight_kg:1,parcel_count:1,carrier:'gls'}].flatMap(d=>[d,{...d,id:'Q'}]);}};
}


for(const width of [1440,1024,390])test('fixed rows and columns survive changing content at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});const f=await fixture(page);const dimensions=()=>page.evaluate(()=>[...document.querySelector('#order-rows').rows].map(row=>({height:row.getBoundingClientRect().height,cells:[...row.cells].map(c=>({width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}))})));
 const before=await dimensions();await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[{...order('A'),recipient:'Destinataire avec une très longue adresse '.repeat(20),issue:'Stock insuffisant '.repeat(40)},order('B')],total:2,page:1,pages:1,summary:{total:2},transportStats:[]}}));await page.evaluate(()=>refreshOrdersQuietly());expect(await dimensions()).toEqual(before);
 await page.locator('[data-order-more-info]').first().click();const dialog=page.locator('#order-rows .order-row-expanded');await expect(dialog).toBeVisible();await expect(dialog).toContainText('Destinataire avec une très longue adresse');await expect(dialog).toContainText('LONG-SKU-REFERENCE-TEST');await expect(dialog.locator('[data-stock-information]').first()).toContainText('10');await expect(page.locator('dialog.order-information-dialog')).toHaveCount(0);await expect(dialog.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','true');expect((await dimensions())[1]).toEqual(before[1]);if(width>900)expect((await dimensions())[0].cells.find(c=>c.width>100)?.width).toBeGreaterThan(200);else expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);const expanded=await dimensions();await page.screenshot({path:'proofs/fixed-details-'+width+'.png',fullPage:false});await dialog.locator('[data-order-more-info]').click();const after=await dimensions();expect(after).toEqual(before);fs.writeFileSync('../geometry-'+width+'.json',JSON.stringify({width,before,expanded,after}));
 await page.screenshot({path:'../fixed-'+width+'.png',fullPage:false});expect(f.errors).toEqual([]);
});
test('full information keeps PDF links and original actions available',async({page})=>{
 const f=await fixture(page);f.change();await page.evaluate(()=>refreshOrdersQuietly());let actionReads=0;await page.route('**/api/resolutions/context?id=A',route=>{actionReads++;return route.fulfill({status:503,json:{error:'Lecture de contrôle fictive'}});});
 await page.locator('[data-order-more-info]').first().click();const dialog=page.locator('#order-rows .order-row-expanded');await expect(dialog.locator('a[href="/api/carriers/documents/A/0"]')).toContainText('PDF PROD');await dialog.getByRole('button',{name:'Remplacer un produit',exact:true}).click();await expect(page.locator('dialog.order-information-dialog')).toHaveCount(0);await expect.poll(()=>actionReads).toBe(1);expect(f.errors).toEqual([]);
});

test('arrow preserves expansion across a changed row and treats partial deliveries independently',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const f=await fixture(page);const main=page.locator('[data-detail="A"]').locator('xpath=ancestor::tr');
 await expect(main.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','false');await expect(main.locator('[data-order-more-info]')).toHaveText('▾');
 const widths=await main.locator('td').evaluateAll(cells=>cells.map(c=>c.getBoundingClientRect().width));await main.locator('[data-order-more-info]').focus();await page.keyboard.press('Enter');
 await expect(main.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','true');await expect(main.getByText('Suspendre la commande',{exact:true})).toBeVisible();await expect(main.getByText('Différer le problème',{exact:true})).toBeVisible();
 f.change();f.partial();await page.evaluate(()=>refreshOrdersQuietly());await expect(main.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','true');
 expect(await main.locator('td[data-fixed-column=label]').evaluate(c=>c.getBoundingClientRect().width)).toBeGreaterThan(200);
 const partial=page.locator('[data-delivery-select="P"]').locator('xpath=ancestor::tr');await expect(partial.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','false');await partial.locator('[data-order-more-info]').click();await expect(partial.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','true');
 await page.evaluate(()=>refreshOrdersQuietly());await expect(page.locator('[data-delivery-select="Q"]').locator('xpath=ancestor::tr').locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','false');await main.locator('[data-order-more-info]').click();await expect(main.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','false');expect(await main.evaluate(el=>el.getBoundingClientRect().height)).toBe(176);await expect(partial.locator('[data-order-more-info]')).toHaveAttribute('aria-expanded','true');expect(f.errors).toEqual([]);
});


test('incoming quantities stay visible in collapsed SKU and expanded cards use horizontal space',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await fixture(page);
 const row=page.locator('[data-detail="A"]').locator('xpath=ancestor::tr'),summary=row.locator('[data-stock-preview]').first();
 await summary.scrollIntoViewIfNeeded();await expect(summary).toContainText('10');await expect(summary).toContainText('LONG-SKU-REFERENCE-TEST');await expect(row.locator('[data-stock-preview]')).toHaveCount(1);await expect(row.locator('[data-fixed-column=carrier] [data-stock-preview]')).toHaveCount(0);await expect(summary).toBeInViewport();
 const box=await summary.boundingBox(),cell=await row.locator('[data-fixed-column="sku"]').boundingBox();expect(box.y).toBeGreaterThanOrEqual(cell.y);expect(box.y+box.height).toBeLessThanOrEqual(cell.y+cell.height);
 await row.locator('[data-order-more-info]').click();const cards=await row.locator('td[data-fixed-column="label"],td[data-fixed-column="carrier"],td[data-fixed-column="sku"]').evaluateAll(c=>c.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width})));expect(new Set(cards.map(c=>c.x)).size).toBe(3);expect(cards.every(c=>c.width>250)).toBe(true);
 await expect(row.locator('[data-stock-information]:not([data-stock-preview])').first()).toContainText('Aucun équivalent');
});

test('explanatory icons preserve names, show descriptions on hover and focus, and keep the arrow',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await fixture(page);const row=page.locator('[data-detail="A"]').locator('xpath=ancestor::tr'),bc=row.getByRole('button',{name:'Actualiser le BC Erplain',exact:true});
 await expect(bc.locator('svg')).toHaveCount(1);await expect(bc).toHaveAttribute('title','Actualiser le BC Erplain');await bc.scrollIntoViewIfNeeded();await bc.hover();await expect(page.getByRole('tooltip')).toContainText('Actualiser le BC Erplain');await bc.focus();await expect(page.getByRole('tooltip')).toBeVisible();
 await expect(row.locator('[data-order-more-info]')).toHaveText('▾');await row.locator('[data-order-more-info]').click();await expect(row.locator('[data-order-more-info]')).toHaveText('▴');await expect(row.getByRole('button',{name:'Suspendre la commande',exact:true}).locator('svg')).toHaveCount(1);await expect(row.getByRole('button',{name:'Différer le problème',exact:true}).locator('svg')).toHaveCount(1);await expect(bc).toBeVisible();
});
