import {test,expect} from '@playwright/test';

for(const width of [1440,390])test('Temu message design loads under production CSP '+width,async({page})=>{
 await page.setViewportSize({width,height:950});
 await page.route('**/*',async route=>{
  if(route.request().resourceType()!=='document')return route.continue();
  const response=await route.fetch();
  await route.fulfill({response,headers:{...response.headers(),'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}});
 });
 await page.route('**/api/temu/messages**',route=>route.fulfill({json:{rows:[],total:0,page:1,pages:1,countries:['FR'],configurationAvailable:true,access:{available:false,reason:'Test isolé : accès non confirmé'},lastSyncAt:null,lastCheckAt:null,coverage:[]}}));
 await page.goto('/');await page.locator('nav [data-view="temu-messages"]').click();
 await expect(page.locator('#tm-countries')).toHaveText('France (FR)');
 await expect(page.locator('#tm-unanswered-count')).toHaveText('Indisponible');
 await expect(page.locator('#tm-unanswered-filter')).toBeDisabled();
 await expect(page.locator('#view-temu-messages .tm-header')).toHaveCSS('display','flex');
 await expect(page.locator('#view-temu-messages .tm-header')).toHaveCSS('padding-left',width===1440?'28px':'16px');
 await expect(page.locator('#view-temu-messages .tm-toolbar')).toHaveCSS('display',width===1440?'flex':'grid');
 await expect(page.locator('#tm-access-badge')).toHaveCSS('border-radius','20px');
 await expect(page.locator('#view-temu-messages .tm-empty')).toHaveCSS('text-align','center');
 await expect(page.locator('main > .notice')).toBeHidden();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#tm-country').selectOption('FR');await expect(page.locator('#tm-reset')).toBeVisible();
 await page.locator('#tm-reset').click();await expect(page.locator('#tm-reset')).toBeHidden();
 await page.screenshot({path:'proofs/temu-messages-csp-'+width+'.png',fullPage:true});
});

test('automatic screen refresh preserves filters and stops outside the view',async({page})=>{
 await page.clock.install();const reads=[],writes=[];
 await page.route('**/api/temu/messages**',route=>{
  const request=route.request();(request.method()==='GET'?reads:writes).push(new URL(request.url()));
  return route.fulfill({json:{rows:[],total:0,page:1,pages:1,countries:['FR'],configurationAvailable:true,access:{available:false,reason:'Test isolated'},lastSyncAt:null,lastCheckAt:null,coverage:[]}});
 });
 await page.goto('/');await page.locator('nav [data-view="temu-messages"]').click();
 await expect(page.locator('#tm-auto')).toContainText('chaque minute');
 await page.locator('#tm-country').selectOption('FR');await page.locator('#tm-response').selectOption('unknown');
 await expect(page.locator('#tm-unanswered-count')).toHaveText('Indisponible');
 const count=reads.length;await page.clock.fastForward(60000);
 await expect.poll(()=>reads.length).toBe(count+1);
 expect(reads.at(-1).searchParams.get('country')).toBe('FR');
 expect(reads.at(-1).searchParams.get('response')).toBe('unknown');
 expect(writes).toHaveLength(0);
 await page.locator('nav [data-view="orders"]').click();const paused=reads.length;
 await page.clock.fastForward(120000);expect(reads).toHaveLength(paused);
});

for(const width of [1440,390])test('message read failure does not block V3 orders '+width,async({page})=>{
 await page.setViewportSize({width,height:950});const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/temu/messages**',route=>route.fulfill({status:503,json:{error:'Synthetic isolated message failure'}}));
 await page.goto('/');await expect(page.locator('#order-rows tr').first()).toBeVisible();
 await page.locator('nav [data-view="temu-messages"]').click();
 await expect(page.locator('#tm-rows')).toContainText('Lecture impossible');
 await expect(page.locator('#tm-unanswered-count')).toHaveText('Indisponible');
 await page.locator('nav [data-view="orders"]').click();
 await expect(page.locator('#view-orders')).toBeVisible();
 await expect(page.locator('#order-rows tr').first()).toBeVisible();
 await expect(page.locator('main > .notice')).toBeVisible();
 expect(errors).toEqual([]);
});
