import {test,expect} from '@playwright/test';
for(const width of [1440,390])test('deferred filter confirms actual selection at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.goto('/');const button=page.locator('#deferred-orders-filter');await expect(button).toHaveAttribute('aria-pressed','false');
 await button.click();await expect(button).toHaveText('✓ Commandes différées · actif');await expect(button).toHaveAttribute('aria-pressed','true');
 await page.locator('#reload').click();await expect(button).toHaveAttribute('aria-pressed','true');
 await page.locator('#clear-filters').click();await expect(button).toHaveText('Commandes différées');await expect(button).toHaveAttribute('aria-pressed','false');
 await button.click();await page.locator('#suspended-orders-filter').click();await expect(button).toHaveAttribute('aria-pressed','false');
 await button.click();await page.locator('#all-problems').click();await expect(button).toHaveAttribute('aria-pressed','false');
 await button.click();await page.screenshot({path:'../active-'+width+'.png',fullPage:false});
});
