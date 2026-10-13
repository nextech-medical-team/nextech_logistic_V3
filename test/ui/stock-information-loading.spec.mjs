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
  const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===20000?150:ms,...args);
  window.api=async(url,data,options)=>{const sku=new URL(url,'https://fixture.test').searchParams.get('sku');reads.push({sku,timeout:options?.timeoutMs});if(sku==='SLOW'&&reads.filter(r=>r.sku==='SLOW').length===1)return new Promise(()=>{});return {original:{incoming:1},equivalentCount:1,equivalents:[{sku:'EQ',available:0}],locationId:'100934',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString()};};
 });
 await page.addScriptTag({content:script});
 await expect(page.locator('[data-stock-information="GOOD"]')).toContainText('À venir ERPLAIN : 1');
 await expect(page.locator('[data-stock-information="SLOW"]')).toContainText('lecture indisponible ou différée');
 expect(await page.evaluate(()=>reads.some(r=>r.sku==='HIDDEN'))).toBe(false);
 expect(await page.evaluate(()=>reads.every(r=>r.timeout===20000))).toBe(true);
 await page.locator('[data-stock-information="SLOW"] button').click();
 await expect(page.locator('[data-stock-information="SLOW"]')).toContainText('À venir ERPLAIN : 1');
 await page.evaluate(()=>{const row=document.querySelector('[data-problem-sku="GOOD"]').parentElement;row.querySelector('small').remove();});
 await expect(page.locator('[data-stock-information="GOOD"]')).toContainText('À venir ERPLAIN : 1');
 expect(await page.evaluate(()=>reads.filter(r=>r.sku==='GOOD').length)).toBe(1);
 await page.screenshot({path:'proofs/stock-information-'+width+'.png'});
});
