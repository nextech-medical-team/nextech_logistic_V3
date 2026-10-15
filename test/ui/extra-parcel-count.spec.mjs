import {test,expect} from '@playwright/test';
test('2 to 3 queues one label, shows pending and failure, and allows a fresh retry',async({page})=>{
 let extras=[],requests=[];
 const order=()=>({id:'EXTRA',reference:'#12891',channel:'shopify',recipient:'Test',address:{country:'FR'},source_date:'2026-10-14',source_payload:{},erp_live:{bc:{id:'bc',label:'C1',status:'active'},bl:{id:'bl',label:'SH1',status:'ready_to_ship'}},document_count:2,label_status:'production_ready',carrier_job:{status:'ready',environment:'production',tracking:['FIRST','SECOND']},sku_lines:[{sku:'SKU',quantity:10000}],carrier:'gls',weight_kg:40,parcel_count:2,extra_parcels:extras});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[order()],total:1,page:1,pages:1,summary:{total:1},transportStats:[]}}));
 await page.route('**/api/parcels/add',async r=>{const b=r.request().postDataJSON();requests.push(b);extras=[...extras,{id:'extra-'+requests.length,parcel_index:3,parcel_total:3,status:'pending'}];await r.fulfill({status:202,json:{id:'extra-'+requests.length,total:3}});});
 await page.goto('/');const row=page.locator('[data-detail=EXTRA]').locator('xpath=ancestor::tr');
 await row.locator('[data-count-pencil]').click();await row.getByRole('spinbutton',{name:'Nombre total d’étiquettes souhaité'}).fill('3');await row.getByRole('button',{name:'Valider',exact:true}).click();
 await expect(row.locator('.parcel-count-container')).toContainText('3 demandée(s)');await expect(row.locator('[data-count-pencil]')).toBeDisabled();expect(requests).toHaveLength(1);expect(requests[0].count).toBe(1);expect(requests[0].expectedTotal).toBe(2);
 extras[0].status='failed';extras[0].error='Erreur GLS de test';await page.evaluate(()=>orders());
 await expect(row).toContainText('Erreur GLS de test');await expect(row.locator('[data-count-pencil]')).toBeEnabled();
 await row.locator('[data-count-pencil]').click();await row.getByRole('spinbutton').fill('3');await row.getByRole('button',{name:'Valider',exact:true}).click();await expect.poll(()=>requests.length).toBe(2);expect(requests[1].requestId).not.toBe(requests[0].requestId);
 extras[1].status='ready';extras[1].tracking='THIRD';await page.evaluate(()=>orders());await expect(row.locator('.parcel-inline-value').filter({hasText:'3 étiquettes'})).toHaveCount(1);await expect(row.locator('a[href="/api/parcels/extra-2/document"]')).toHaveCount(1);await expect(row).not.toContainText('Erreur GLS de test');await expect(row).toContainText('40 kg · 3 colis');
});
