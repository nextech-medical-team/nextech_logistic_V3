import {test,expect} from '@playwright/test';
test('existing reference offers documentary attachment despite preparation warnings',async({page})=>{
 const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const document={id:'bc',label:'BC-TEST',external_reference:'REF',line_items:[],shipping_orders:{data:[{id:'first',label:'BL-1',status:'delivered'},{id:'second',label:'BL-2',status:'in_preparation'}]}};
 await page.route('**/api/erplain-refresh/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('recovered-orders'))return route.fulfill({json:{rows:[],total:0,page:1,pages:1}});
  if(path.endsWith('targeted-lookup'))return route.fulfill({json:{document,reviewHash:'a'.repeat(64),admissionIssues:[],preparationIssues:['Stock insuffisant'],reconcileCandidate:{orderId:'existing',reference:'REF'},existingMatches:[{orderId:'existing',reference:'REF',sourceReference:'SOURCE-REF',archived:true,matchReason:'Même référence source'}]}});
  if(path.endsWith('targeted-reconcile')){writes.push(route.request().postDataJSON());return route.fulfill({json:{orderId:'existing',alreadyRecovered:true,preparationStarted:false,message:'BC et BL récupérés sur la commande existante.'}});}
  return route.fallback();
 });
 await page.goto('/');await page.locator('button[data-view="erplain-refresh"]').click();
 await page.locator('#erplain-one-reference').fill('BC-TEST');await page.locator('#erplain-one-fetch').click();
 const box=page.locator('#erplain-one-preview');await expect(box).toContainText('BL-2');await expect(box).toContainText('Stock insuffisant');await expect(box).toContainText('Archivée (masquée dans la liste habituelle)');await expect(box).toContainText('SOURCE-REF');await expect(box).toContainText('Identifiant V3 : existing');
 await expect(box.locator('[data-erplain-approve]')).toHaveCount(0);
 await box.locator('[data-erplain-reconcile]').click();
 await expect(page.locator('#erplain-one-note')).toContainText('BC et BL récupérés');await expect(box.locator('[data-erplain-open]').first()).toBeVisible();
 expect(writes).toEqual([{bcId:'bc',orderId:'existing',reviewHash:'a'.repeat(64),confirmed:true}]);expect(errors).toEqual([]);
});
