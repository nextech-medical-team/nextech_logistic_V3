import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
if(process.env.UI_CHROME_PATH)test.use({launchOptions:{executablePath:process.env.UI_CHROME_PATH}});
for(const width of [1440,390])test('TEMU shows both margins and their transport sources without confusing a forecast with a quote '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><section id="view-orders"><h1>Commandes TEMU — données fictives</h1><div class="table-wrap"><table><thead><tr><th>Commande</th></tr></thead><tbody id="order-rows"><tr><td><button data-detail="fixture">PO-096-123456789</button><span class="order-country">Irlande</span></td></tr></tbody></table></div></section></main></body></html>');
 await page.addStyleTag({content:await fs.readFile('public/style.css','utf8')});
 await page.evaluate(()=>{
  window.$=id=>document.getElementById(id);window.user={role:'admin'};window.currentView='orders';window.orderDetail=()=>{};window.displayErrorMessage=e=>e.message;
  window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const base={status:'negative',profit:-4,margin:-.2,markup:-.16,revenue:18,credit:2,totalReceipts:20,purchase:12,supplierShipping:2,shipping:10,fees:0,other:0,totalCosts:24,issues:[],warnings:[],lines:[]};
  window.testMargin={...base,id:'fixture',reference:'PO-096-123456789',channel:'temu',calculatorMargin:{...base,status:'positive',profit:1,shipping:5,shippingSource:'Calculateur publié · Chronopost Warehouse Z2 · 0.25 kg · 5 € HT',basis:'calculator'},temuMargin:{...base,basis:'quote',stale:true,shippingSource:'Devis TEMU final : 12 € TTC · 10 € HT'}};
  window.api=async()=>({source:{capturedAt:'2026-10-22T00:00:00Z',version:'fixture-only'},calculatedAt:new Date().toISOString(),rows:[testMargin]});
 });
 await page.addScriptTag({content:await fs.readFile('public/margins.js','utf8')});await page.evaluate(()=>V3Margins.refresh());
 const chip=page.locator('[data-margin-chip]');await expect(chip).toContainText('Calculateur (prévision) : +1,00');await expect(chip).toContainText('Devis TEMU expiré : -4,00');
 await expect(chip.locator('.is-positive')).toHaveCount(1);await expect(chip.locator('.is-negative')).toHaveCount(1);
 // Repaints must settle: an observer loop would prevent this timer firing.
 await expect.poll(()=>page.evaluate(()=>new Promise(resolve=>setTimeout(()=>resolve(true),30)))).toBe(true);
 await chip.click();const detail=page.locator('#margin-detail-dialog');await expect(detail).toBeVisible();await expect(detail).toContainText('Chronopost Warehouse Z2');await expect(detail).toContainText('sa disponibilité dans TEMU n’est pas garantie');
 await expect(detail).toContainText('Le devis TEMU est expiré');
 await page.screenshot({path:'/tmp/temu-margin-comparison-'+width+'.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);expect(errors).toEqual([]);
});
