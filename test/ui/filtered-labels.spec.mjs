import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]])test('all filtered labels '+name,async({page})=>{
 await page.setViewportSize(viewport);await page.goto('/');await expect(page.locator('#page-info')).toContainText('120 commandes');
 const button=page.locator('#download-filtered-labels');await expect(button).toBeEnabled();await button.click();
 const modal=page.getByRole('dialog',{name:'Étiquettes de la sélection'});await expect(modal).toBeVisible();await expect(modal.locator('[data-count]')).toContainText('120 commande(s)');
 await page.screenshot({path:'proofs/filtered-labels-'+name+'.png',fullPage:false});await modal.locator('[data-close]').click();
 await page.locator('#search').fill('TEST-0000');await expect(page.locator('#page-info')).toContainText('10 commandes');await button.click();await expect(modal.locator('[data-count]')).toContainText('10 commande(s)');
});
