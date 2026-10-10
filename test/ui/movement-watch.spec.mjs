import {test,expect} from '@playwright/test';
const fixture=()=>({watchdog:{lastSuccessAt:new Date().toISOString()},rows:[{order_id:'fictional-1',reference:'TEST-MOVEMENT-1',detail:'Déduction historique confirmée ; suspension conservée.',last_check_at:new Date().toISOString(),next_check_at:new Date(Date.now()+900000).toISOString(),alerted_at:new Date().toISOString()},{order_id:'fictional-2',reference:'TEST-MOVEMENT-2',detail:'Lecture incomplète <img src=x onerror=alert(1)>',next_check_at:new Date().toISOString(),overdue:true}]});
for(const [name,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]])test('movement watch '+name,async({page})=>{
 await page.setViewportSize(viewport);const writes=[];const existingReadPosts=['/api/partial/visible','/api/orders/processing'];page.on('request',r=>{if(r.method()!=='GET'&&!existingReadPosts.includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.route('**/api/movement-watch',r=>r.fulfill({json:fixture()}));await page.goto('/');
 const panel=page.locator('#movement-watch-panel');await expect(panel).toBeVisible();await expect(panel).toContainText('2 commandes suivies');await expect(panel).toContainText('15 minutes');await expect(panel).toContainText('5 minutes');
 await panel.locator('summary').click();await expect(panel.locator('article')).toHaveCount(2);await expect(panel).toContainText('Prochaine vérification');await expect(panel.locator('img')).toHaveCount(0);
 await page.screenshot({path:'proofs/movement-watch-'+name+'.png',fullPage:false});
 const bounds=await panel.boundingBox();expect(bounds.width).toBeLessThanOrEqual(viewport.width);
 await panel.getByRole('button',{name:'Voir la commande'}).first().click();await expect(page.locator('#search')).toHaveValue('TEST-MOVEMENT-1');expect(writes).toEqual([]);
});
test('movement watchdog failure is visible',async({page})=>{await page.route('**/api/movement-watch',r=>r.fulfill({json:{...fixture(),watchdog:{}}}));await page.goto('/');await expect(page.locator('#movement-watch-panel')).toContainText('intervention nécessaire');});
test('unauthorized watch is hidden',async({page})=>{await page.route('**/api/movement-watch',r=>r.fulfill({status:403,json:{error:'Forbidden'}}));await page.goto('/');await expect(page.locator('#page-info')).toContainText('120 commandes');await expect(page.locator('#movement-watch-panel')).toBeHidden();});
