import {test,expect} from '@playwright/test';
import fs from 'node:fs';

const order={id:'reference-refresh',reference:'#12780',channel:'shopify',recipient:'Destinataire fictif',address:{country:'FR',city:'Ville test',postal:'00000'},source_date:'2026-10-01T20:04:00Z',source_payload:{shopifyDeliveryMode:'relay'},sku_lines:[{sku:'TEST-SKU',quantity:1}],line_count:1,item_quantity:1,weight_kg:1,parcel_count:1,carrier:'gls_shop',label_status:'production_pending',tracking_status:'not_shipped',erp_live_job:{status:'complete'},erp_live:{bc:{id:'BC-TEST',status:'active'},bl:{id:'BL-TEST',status:'ready_to_ship'}}};
const completed=o=>({...o,label_status:'production_ready',document_count:1,carrier_job:{status:'ready',environment:'production',tracking:['TEST-TRACKING']}});

async function fixture(page,patch={}){
 let row={...structuredClone(order),...patch},reads=0;const writes=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const p=new URL(r.url()).pathname;if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(p))writes.push(p)});
 await page.route(/\/api\/orders(?:\?|$)/,r=>{reads++;return r.fulfill({json:{rows:[row],total:1,page:1,pages:1,summary:{total:1},transportStats:[]}})});
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at:new Date().toISOString(),rows:[{id:row.id,monitoring:{lastCheck:new Date().toISOString(),followUp:true,result:'Aucun blocage constaté',nextStep:'Aucune action attendue'}}]}}));
 await page.goto('/');await expect(page.locator('[data-detail="'+order.id+'"]')).toBeVisible();
 await page.locator('[data-id="'+order.id+'"]').check();
 return {finish:()=>{row=completed(row)},change:()=>{row={...row,issue:'Contrôle fictif'}},reads:()=>reads,writes,errors};
}

async function selectReference(page,{start=0,end=6,backward=false}={}){
 await page.evaluate(({start,end,backward})=>{const text=document.querySelector('[data-detail="reference-refresh"]').firstChild;window.getSelection().setBaseAndExtent(text,backward?end:start,text,backward?start:end)},{start,end,backward});
}

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('PDF and tracking update while the reference stays selected '+name,async({page})=>{
 await page.setViewportSize(viewport);const f=await fixture(page);await selectReference(page);
 const before=f.reads();f.finish();
 const timing=await page.evaluate(async()=>{const begin=performance.now();return {refreshed:await refreshOrdersQuietly(),refreshMs:performance.now()-begin}}),refreshed=timing.refreshed;
 if(!refreshed){await page.screenshot({path:'proofs/reference-refresh-before-'+name+'.png',fullPage:false});fs.writeFileSync('proofs/reference-refresh-before-'+name+'.json',JSON.stringify({status:'REPRODUCED',refreshed,readsBefore:before,readsAfter:f.reads(),selectedReference:await page.evaluate(()=>window.getSelection().toString()),pdfLinks:await page.locator('a.pdf-link').count(),scope:'Réponse fictive passée à production_ready ; source installée refuse la lecture actualisée'}))}
 expect(refreshed).toBe(true);
 await expect(page.locator('a.pdf-link[href="/api/carriers/documents/reference-refresh/0"]')).toContainText('PDF PROD');
 await expect(page.locator('#order-rows')).toContainText('TEST-TRACKING');
 expect(f.reads()).toBeGreaterThan(before);
 expect(await page.evaluate(()=>window.getSelection().toString())).toBe('#12780');
 await expect(page.locator('[data-id="reference-refresh"]')).toBeChecked();
 await expect(page.locator('#selection-count')).toContainText('1 sélection');
 await expect(page.locator('#order-rows [data-resume-order]')).toHaveCount(0);
 await expect(page.locator('#order-rows .order-processing')).toHaveCount(0);
 await page.locator('a.pdf-link').scrollIntoViewIfNeeded();
 await page.screenshot({path:'proofs/reference-refresh-'+name+'.png',fullPage:false});
 expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
 fs.writeFileSync('proofs/reference-refresh-'+name+'.json',JSON.stringify({status:'PASS',viewport,pdfVisible:true,trackingVisible:true,referenceSelectionPreserved:true,checkboxPreserved:true,refreshMs:timing.refreshMs,writes:f.writes,errors:f.errors,scope:'Application complète et commande fictive, aucune écriture fournisseur'}));
});

test('unchanged rows keep their DOM and reverse partial reference selection',async({page})=>{
 const f=await fixture(page);await selectReference(page,{start:1,end:4,backward:true});
 await page.evaluate(()=>{document.querySelector('[data-detail="reference-refresh"]').dataset.testIdentity='retained'});
 expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(true);
 await expect(page.locator('[data-detail="reference-refresh"]')).toHaveAttribute('data-test-identity','retained');
 expect(await page.evaluate(()=>({text:window.getSelection().toString(),anchor:window.getSelection().anchorOffset,focus:window.getSelection().focusOffset}))).toEqual({text:'127',anchor:4,focus:1});
 f.change();expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(true);
 expect(await page.evaluate(()=>({text:window.getSelection().toString(),anchor:window.getSelection().anchorOffset,focus:window.getSelection().focusOffset}))).toEqual({text:'127',anchor:4,focus:1});
 expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

test('text in other cells remains protected until the user clears the selection',async({page})=>{
 const f=await fixture(page);
 await page.locator('#order-rows td').filter({hasText:'Destinataire fictif'}).evaluate(cell=>{const text=cell.firstChild;window.getSelection().setBaseAndExtent(text,0,text,text.textContent.length)});
 const before=f.reads();f.finish();expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(false);expect(f.reads()).toBe(before);
 expect(await page.evaluate(()=>window.getSelection().toString())).toBe('Destinataire fictif');
 await page.evaluate(()=>window.getSelection().removeAllRanges());expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(true);
 await expect(page.locator('a.pdf-link')).toContainText('PDF PROD');expect(f.writes).toEqual([]);
});

test('an open detail or inline editor still prevents background replacement',async({page})=>{
 const f=await fixture(page);await selectReference(page);f.finish();const before=f.reads();
 await page.evaluate(()=>{const d=document.createElement('dialog');d.id='test-protected-dialog';document.body.append(d);d.showModal()});
 expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(false);expect(f.reads()).toBe(before);
 await page.evaluate(()=>document.getElementById('test-protected-dialog').remove());
 await selectReference(page);await page.evaluate(()=>document.querySelector('#order-rows').dataset.inlineEditing='true');
 expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(false);expect(f.reads()).toBe(before);
 await page.evaluate(()=>delete document.querySelector('#order-rows').dataset.inlineEditing);
 expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(true);await expect(page.locator('a.pdf-link')).toContainText('PDF PROD');
});

test('a deliberate label request refreshes even with other row text selected',async({page})=>{
 const f=await fixture(page);const requests=[];
 await page.route('**/api/carriers/labels',r=>{requests.push(r.request().postDataJSON());f.finish();return r.fulfill({json:{queued:1,message:'Demande fictive enregistrée'}})});
 await page.locator('#order-rows td').filter({hasText:'Destinataire fictif'}).evaluate(cell=>{const text=cell.firstChild;window.getSelection().setBaseAndExtent(text,0,text,text.textContent.length)});
 await page.getByRole('button',{name:'Créer les étiquettes transporteurs PROD',exact:true}).click();
 await expect(page.locator('a.pdf-link')).toContainText('PDF PROD');
 expect(requests).toEqual([{ids:['reference-refresh']}]);expect(f.errors).toEqual([]);
});

test('the live change event updates a highlighted reference without manual reload',async({page})=>{
 let release;const change=new Promise(resolve=>{release=resolve});
 await page.route('**/api/events',async r=>{await change;await r.fulfill({contentType:'text/event-stream',body:'event: change\ndata: {}\n\n'})});
 const f=await fixture(page);await selectReference(page);f.finish();release();
 await expect(page.locator('a.pdf-link')).toContainText('PDF PROD',{timeout:10000});
 expect(await page.evaluate(()=>window.getSelection().toString())).toBe('#12780');expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});

for(const [channel,carrier,country] of [['amazon','gofo','FR'],['shopify','gls','BE'],['tender','gls_pharma','FR'],['samples','gls','DE']])test('reference refresh also applies to '+channel+' '+carrier+' '+country,async({page})=>{
 const f=await fixture(page,{channel,carrier,address:{country,city:'Ville test',postal:'00000'}});await selectReference(page);f.finish();
 expect(await page.evaluate(()=>refreshOrdersQuietly())).toBe(true);await expect(page.locator('a.pdf-link')).toContainText('PDF PROD');
 expect(await page.evaluate(()=>window.getSelection().toString())).toBe('#12780');expect(f.writes).toEqual([]);expect(f.errors).toEqual([]);
});
