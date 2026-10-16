import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const script=fs.readFileSync(new URL('../../public/margins.js',import.meta.url),'utf8');
async function instrument(page){
 await page.evaluate(()=>{window.marginObserverCalls=0;window.marginObserverTripped=false;const Native=MutationObserver;window.MutationObserver=class extends Native{constructor(cb){super((records,observer)=>{if(++marginObserverCalls>100){marginObserverTripped=true;observer.disconnect();return;}cb(records,observer);});}};});
}
async function fixture(page,{delivered=true,status='incomplete',missing=false}={}){
 await page.setContent(`<table><thead><tr><th>Référence</th></tr></thead><tbody id="order-rows"><tr data-order-delivered="${delivered}"><td><span data-detail="A">PERFORMANCE-TEST</span><small class="order-country">FR</small><span class="processing-elapsed">0 s</span></td></tr></tbody></table>`);
 await page.evaluate(({status,missing})=>{window.$=id=>document.getElementById(id);window.esc=s=>String(s??'');window.user=null;window.currentView='orders';window.fixtureRows=missing?[]:[{id:'A',reference:'PERFORMANCE-TEST',status,profit:12,margin:.2,markup:.3,issues:[],lines:[]}];window.api=async()=>({available:false,reason:'Synthetic fixture',rows:fixtureRows});},{status,missing});
 await instrument(page);await page.addScriptTag({content:script});await page.evaluate(()=>V3Margins.refresh());
}
for(const width of [1440,390])for(const status of ['incomplete','positive','negative','zero'])test(`margin observer settles for delivered ${status} at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await fixture(page,{status});
 await expect(page.locator('.order-country')).toHaveText('FR');await expect.poll(()=>page.evaluate(()=>marginObserverCalls)).toBeLessThan(20);
 const before=await page.evaluate(()=>marginObserverCalls);await page.evaluate(async()=>{const clock=document.querySelector('.processing-elapsed');for(let i=0;i<30;i++){clock.textContent=i+' s';await Promise.resolve();}});
 expect(await page.evaluate(()=>marginObserverTripped)).toBe(false);expect(await page.evaluate(()=>marginObserverCalls)-before).toBeLessThanOrEqual(30);
 if(status==='incomplete'){await expect(page.locator('[data-margin-empty]')).toHaveText('—');await expect(page.locator('[data-margin-chip]')).toHaveCount(0);}else await expect(page.locator('[data-margin-chip]')).toHaveCount(1);
 await page.screenshot({path:`proofs/performance-margin-${status}-${width}.png`});
});
test('delivered margin transitions preserve country and replace placeholder when verified',async({page})=>{
 await fixture(page);await expect(page.locator('[data-margin-empty]')).toHaveCount(1);
 await page.evaluate(()=>{fixtureRows[0]={...fixtureRows[0],status:'positive'};return V3Margins.refresh();});await expect(page.locator('[data-margin-chip]')).toHaveCount(1);await expect(page.locator('[data-margin-empty]')).toHaveCount(0);
 await page.evaluate(()=>{fixtureRows[0]={...fixtureRows[0],status:'incomplete'};return V3Margins.refresh();});await expect(page.locator('[data-margin-chip]')).toHaveCount(0);await expect(page.locator('[data-margin-empty]')).toHaveCount(1);await expect(page.locator('.order-country')).toHaveText('FR');expect(await page.evaluate(()=>marginObserverTripped)).toBe(false);
});
test('active and partial delivery rows keep incomplete margin visible',async({page})=>{
 await fixture(page,{delivered:false});await expect(page.locator('[data-margin-chip]')).toHaveText('Marge à compléter');await expect(page.locator('.order-country')).toHaveText('FR');expect(await page.evaluate(()=>marginObserverTripped)).toBe(false);
});
test('new rows receive margin after structural mutation',async({page})=>{
 await fixture(page,{delivered:false});await page.evaluate(()=>{fixtureRows.push({...fixtureRows[0],id:'B'});document.querySelector('#order-rows').insertAdjacentHTML('beforeend','<tr><td><span data-detail="B">NEW-TEST</span><small class="order-country">BE</small></td></tr>');return V3Margins.refresh();});await expect(page.locator('[data-margin-chip]')).toHaveCount(2);await expect(page.locator('.order-country')).toHaveText(['FR','BE']);expect(await page.evaluate(()=>marginObserverTripped)).toBe(false);
});
test('TEMU host on delivered row with absent margin settles without stale loading text',async({page})=>{
 await fixture(page,{missing:true});await page.evaluate(()=>{const cell=document.createElement('td');cell.dataset.temuMargin='A';cell.textContent='Chargement de la marge…';document.querySelector('#order-rows tr').append(cell);});await expect(page.locator('[data-temu-margin]')).toHaveText('—');await expect(page.locator('.order-country')).toHaveText('FR');expect(await page.evaluate(()=>marginObserverTripped)).toBe(false);
});
