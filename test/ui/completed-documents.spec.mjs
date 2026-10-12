import {test,expect} from '@playwright/test';
const at='2026-10-12T12:00:00Z';
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('three documents suppress all current blocking panels '+name,async({page})=>{
 await page.setViewportSize(viewport);
 const complete={id:'complete',reference:'COMPLETE-TEST',channel:'shopify',recipient:'Synthetic recipient',address:{country:'FR',city:'Paris',postal:'75001'},source_payload:{},source_date:'12/10/26',sku_lines:[{sku:'TEST',quantity:1}],line_count:1,item_quantity:1,label_status:'blocked',erp_status:'live_review',tracking_status:'not_shipped',carrier:'gls',document_count:1,carrier_job:{status:'ready',error:'Stock insuffisant',stock_override:true},erp_live:{bc:{id:1,label:'BC TEST',status:'active'},bl:{id:2,label:'BL TEST',status:'ready_to_ship'}},issue:'Stock insuffisant',resolution_error:'Erreur historique'};
 const incomplete={...structuredClone(complete),id:'incomplete',reference:'INCOMPLETE-TEST',erp_live:{bc:complete.erp_live.bc},document_count:0,carrier_job:{status:'failed',error:'Stock insuffisant'}};
 let polls=0;const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/partial/visible','/api/orders/processing'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows:[complete,incomplete],total:2,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>{polls++;return r.fulfill({json:{at,rows:[complete,incomplete].map(o=>({id:o.id,state:'blocked',stage:'Préparation à vérifier',reason:'Stock insuffisant',since:at,monitoring:{blocked:true,result:'Stock insuffisant',alert:true}}))}});});
 await page.route('**/api/order-detail?*',r=>r.fulfill({json:{order:{...complete,complete_order_documents:true},lines:[],jobs:[{kind:'label',status:'failed',error:'Ancien blocage conservé'}]}}));
 await page.goto('/');await expect.poll(()=>polls).toBeGreaterThan(0);
 const yes=page.locator('#order-rows tr[data-complete-order-documents="true"]'),no=page.locator('#order-rows tr[data-complete-order-documents="false"]');
 await expect(yes).toHaveCount(1);await expect(yes.locator('.compact-problem')).toHaveCount(0);await expect(yes.locator('.order-processing')).toHaveCount(0);await expect(yes).not.toContainText('stock insuffisant');await expect(yes.locator('a.pdf-link')).toHaveCount(1);
 await expect(no.locator('.compact-problem')).not.toHaveCount(0);await expect(no.locator('.order-processing')).toHaveCount(1);
 await yes.scrollIntoViewIfNeeded();await page.screenshot({path:'proofs/completed-documents-'+name+'.png'});
 await page.getByRole('button',{name:'COMPLETE-TEST',exact:true}).click();await expect(page.getByText('Historique des traitements',{exact:true})).toBeVisible();await expect(page.getByText('Ancien blocage conservé',{exact:false})).not.toBeVisible();
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});
