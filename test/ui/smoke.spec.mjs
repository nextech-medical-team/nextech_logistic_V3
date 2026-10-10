import {test,expect} from '@playwright/test';import fs from 'node:fs';
for(const [name,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]])test(name+' synthetic UI',async({page})=>{
 await page.setViewportSize(viewport);
 await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:31234/')?route.continue():route.abort());
 await page.goto('/');await expect(page.locator('#page-info')).toContainText('120 commandes');
 const filter=page.locator('details').filter({has:page.locator('summary').filter({hasText:'Type de problème'})});
 await filter.locator('summary').click();
 const search=filter.locator('input[type=search]');await expect(search).toBeEnabled();
 await search.fill('poids');await expect(filter.getByRole('checkbox',{name:/Unité de poids invalide/})).toBeVisible();
 await filter.getByRole('checkbox',{name:/Unité de poids invalide/}).check();await expect(page.locator('#page-info')).toContainText('40 commandes');
 await page.screenshot({path:'proofs/'+name+'.png',fullPage:false});
 await filter.locator('summary').click();
 await page.locator('#clear-filters').click();await expect(page.locator('#page-info')).toContainText('120 commandes');
 if(name==='desktop'){
  await page.locator('#next').click();await expect(page.locator('#page-info')).toContainText('page 2 / 3');
  const metrics=await (await page.request.get('/test-metrics')).json();expect(metrics.maxMs).toBeLessThan(1000);fs.writeFileSync('proofs/performance.json',JSON.stringify(metrics));
 }
});
