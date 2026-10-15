import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const script=await readFile(process.env.STOCK_UI_SOURCE||new URL('../../public/stock-information.js',import.meta.url),'utf8');
const css=await readFile(new URL('../../public/style.css',import.meta.url),'utf8');
// Local DOM and fictitious provider; no connection to production.
for(const width of [1440,390])test(`stock visible rows, bounded wait, retry and cached re-render ${width}`,async({page})=>{
 await page.setViewportSize({width,height:844});
 await page.setContent('<div id="view-orders"><div id="order-rows"><div><button class="compact-problem" data-problem-type="stock" data-problem-sku="SLOW">Stock</button></div><div><button class="compact-problem" data-problem-type="stock" data-problem-sku="GOOD">Stock</button></div><div style="margin-top:2000px"><button class="compact-problem" data-problem-type="stock" data-problem-sku="HIDDEN">Stock</button></div></div></div>');
 await page.addStyleTag({content:css});
 await page.evaluate(()=>{
  window.reads=[];window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms>0&&ms<=20000?150:ms,...args);
  window.api=async(url,data,options)=>{const sku=new URL(url,'https://fixture.test').searchParams.get('sku');reads.push({sku,timeout:options?.timeoutMs});if(sku==='SLOW'&&reads.filter(r=>r.sku==='SLOW').length===1)return new Promise(()=>{});return {original:{incoming:1},equivalentCount:1,equivalents:[{sku:'EQ',available:0}],locationId:'100934',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()};};
 });
 await page.addScriptTag({content:script});
 await expect(page.locator('[data-stock-information="GOOD"]')).toContainText('À venir ERPLAIN : 1');
 await expect(page.locator('[data-stock-information="SLOW"]')).toContainText('quantité non vérifiée');
 expect(await page.evaluate(()=>reads.some(r=>r.sku==='HIDDEN'))).toBe(false);
 expect(await page.evaluate(()=>reads.every(r=>r.timeout>0&&r.timeout<=20000))).toBe(true);
 await page.locator('[data-stock-information="SLOW"] button').click();
 await expect(page.locator('[data-stock-information="SLOW"]')).toContainText('À venir ERPLAIN : 1');
 await page.evaluate(()=>{const row=document.querySelector('[data-problem-sku="GOOD"]').parentElement;row.querySelector('small').remove();});
 await expect(page.locator('[data-stock-information="GOOD"]')).toContainText('À venir ERPLAIN : 1');
 expect(await page.evaluate(()=>reads.filter(r=>r.sku==='GOOD').length)).toBe(1);
 await page.screenshot({path:'proofs/stock-information-'+width+'.png'});
});

for(const empty of [true,false])test('periodic stock refresh handles empty and populated tables '+empty,async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<div id="view-orders"><div id="order-rows">'+(empty?'':'<button class="compact-problem" data-problem-type="stock" data-problem-sku="TEST">Stock</button>')+'</div></div>');
 await page.evaluate(()=>{window.reads=0;window.stockNow=Date.now();Date.now=()=>window.stockNow;window.stockTimers=[];window.setInterval=fn=>{stockTimers.push(fn);return stockTimers.length;};window.esc=s=>String(s??'');window.api=async()=>{reads++;if(reads===2)throw Error('Lecture indisponible');return {original:{incoming:reads},equivalentCount:0,equivalents:[],locationId:'TEST',checkedAt:new Date().toISOString(),expiresAt:new Date(stockNow+30000).toISOString()};};});
 await page.addScriptTag({content:script});
 if(empty){await page.evaluate(()=>stockTimers.forEach(fn=>fn()));expect(await page.evaluate(()=>reads)).toBe(0);expect(errors).toEqual([]);return;}
 const info=page.locator('[data-stock-information]');await expect(info).toContainText('ERPLAIN : 1');await page.evaluate(()=>stockTimers.forEach(fn=>fn()));expect(await page.evaluate(()=>reads)).toBe(1);
 await page.evaluate(()=>{stockNow+=31000;stockTimers.forEach(fn=>fn());});await expect(info).toContainText('quantité non vérifiée');
 await info.locator('button').click();await expect(info).toContainText('ERPLAIN : 3');
 await page.evaluate(()=>{stockNow+=31000;document.getElementById('view-orders').hidden=true;stockTimers.forEach(fn=>fn());});expect(await page.evaluate(()=>reads)).toBe(3);
 await page.evaluate(()=>{document.getElementById('view-orders').hidden=false;stockTimers.forEach(fn=>fn());});await expect(info).toContainText('ERPLAIN : 4');expect(errors).toEqual([]);
});

for(const width of [1440,390])test(`queued reads are truthful and bounded including wait ${width}`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.clock.install();
 await page.setContent('<div id="view-orders"><div id="order-rows"><div id="a"></div><div id="b"></div><div id="c"></div></div></div>');
 await page.evaluate(()=>{window.stockTime=Date.now();Date.now=()=>stockTime;window.reads=[];window.esc=s=>String(s??'');window.api=async url=>{reads.push(url);return new Promise(()=>{});};});
 await page.addScriptTag({content:script});
 await page.evaluate(()=>{for(const id of ['a','b','c'])V3StockInformation.populate(document.getElementById(id),id);});
 await expect(page.locator('#a')).toContainText('lecture demandée à V3');
 await expect(page.locator('#c')).toContainText('lecture en attente');
 expect(await page.evaluate(()=>reads.length)).toBe(2);
 await page.evaluate(()=>{stockTime+=20001;});await page.clock.runFor(20001);
 await expect(page.locator('#c')).toContainText('lecture différée');
 await expect(page.locator('#a')).toContainText('délai de réponse dépassé');
 await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
 expect(await page.evaluate(()=>reads.length)).toBe(2);
 await page.screenshot({path:'proofs/stock-truthful-'+width+'.png'});
 await page.evaluate(()=>{window.api=async()=>({original:{incoming:0},equivalentCount:0,equivalents:[],locationId:'TEST',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()});});
 await page.locator('#c [data-stock-retry]').click();await expect(page.locator('#c')).toContainText('À venir ERPLAIN : 0');
});

test('unknown quantity and expired session never become zero or keep loading',async({page})=>{
 await page.setContent('<div id="order-rows"><div id="unknown"></div><div id="auth"></div></div>');
 await page.evaluate(()=>{window.esc=s=>String(s??'');window.api=async url=>{if(url.includes('auth'))throw Object.assign(Error('expired'),{status:401});return {original:{incoming:null},equivalentCount:0,equivalents:[],locationId:'TEST',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()};};});
 await page.addScriptTag({content:script});await page.evaluate(()=>{for(const id of ['unknown','auth'])V3StockInformation.populate(document.getElementById(id),id);});
 await expect(page.locator('#unknown')).toContainText('non vérifiée');await expect(page.locator('#unknown [data-stock-retry]')).toHaveCount(1);
 await expect(page.locator('#auth')).toContainText('session V3 expirée');await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
