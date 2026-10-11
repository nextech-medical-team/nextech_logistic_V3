import {test,expect} from '@playwright/test';
for(const [name,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]])test('compact diagnostic messages '+name,async({page})=>{
 await page.setViewportSize(viewport);
 let reads=0;
 const longReason=('Adresse refusée : caractères à vérifier. ').repeat(100)+'FIN DU MESSAGE';
 await page.route('**/api/orders/processing',async route=>{
  reads++;
  const ids=route.request().postDataJSON().ids;
  await route.fulfill({json:{at:new Date().toISOString(),rows:ids.slice(0,2).map((id,i)=>({id,stage:'TEMU · Préparation / document à vérifier',state:'blocked',since:new Date().toISOString(),reason:i?longReason:'Message court',activities:[],monitoring:{lastCheck:new Date().toISOString(),result:'Contrôle '+reads}}))}});
 });
 await page.goto('/');
 const boxes=page.locator('.order-processing');await expect(boxes).toHaveCount(2);
 const first=boxes.nth(0),second=boxes.nth(1),toggle=second.locator('.processing-details-toggle');
 await expect(toggle).toHaveAttribute('aria-expanded','false');
 const heights=await boxes.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));expect(Math.abs(heights[0]-heights[1])).toBeLessThan(1);expect(heights[1]).toBeLessThan(180);
 await expect(second.locator('.processing-reason')).toHaveText('Motif : '+longReason);
 await second.screenshot({path:'proofs/compact-messages-'+name+'.png'});
 await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');
 expect(await second.locator('.processing-content').evaluate(n=>n.clientHeight>=n.scrollHeight)).toBe(true);
 const before=reads;await expect.poll(()=>reads).toBeGreaterThan(before);await expect(toggle).toHaveAttribute('aria-expanded','true');
 await expect(first.locator('.processing-details-toggle')).toHaveAttribute('aria-expanded','false');
 await second.screenshot({path:'proofs/compact-messages-'+name+'-expanded.png'});
 await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
 const after=await second.evaluate(n=>n.getBoundingClientRect().height);expect(Math.abs(after-heights[1])).toBeLessThan(1);
});
