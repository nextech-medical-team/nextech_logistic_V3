import {test,expect} from '@playwright/test';
import fs from 'node:fs';
const labels={1:'En attente',2:'À expédier',3:'Annulée',4:'Expédiée',5:'Reçue',41:'Partiellement expédiée',51:'Partiellement reçue',99:'Statut non reconnu'};
for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('TEMU code and concise label '+name,async({page})=>{
 await page.setViewportSize(viewport);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const rows=Object.keys(labels).map(code=>({id:'synthetic-'+code,reference:'TEST-TEMU-'+code,channel:'temu',recipient:'Fictif',address:{country:'FR'},source_date:'2026-10-11T08:00:00Z',sku_lines:[],source_payload:{},erp_live:{},label_status:'pending',tracking_status:'unknown',platform_status:{channel:'temu',status:code,cancelled:code==='3',observedAt:'2026-10-11T08:00:00Z'},logistics_observation:{status:'unknown',parcels:[]}}));
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows,total:rows.length,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.goto('/');await expect(page.locator('#order-rows tr')).toHaveCount(rows.length);
 for(const [code,label] of Object.entries(labels)){
  const cell=page.locator('#order-rows tr').filter({has:page.locator('[data-detail="synthetic-'+code+'"]')}).locator('[data-platform-status]');
  await expect(cell).toContainText('Code '+code);await expect(cell.locator('[data-temu-status-label]')).toHaveText(label);await expect(cell.locator('button')).toHaveCount(0);
  if(name==='mobile'){await cell.locator('xpath=ancestor::tr').locator('[data-order-more-info]').click();await expect(page.locator('#order-rows .order-row-expanded [data-temu-status-label]')).toHaveCount(1);await expect(page.locator('#order-rows .order-row-expanded')).toContainText(label);}
  const visibleCell=cell;
  const geometry=await visibleCell.evaluate(el=>{const span=el.querySelector('[data-temu-status-label]')||[...el.querySelectorAll('.badge span')].find(n=>n.textContent);const badge=span.parentElement;const range=document.createRange();range.selectNodeContents(badge.firstChild);return {labelY:span.getBoundingClientRect().top,codeY:range.getBoundingClientRect().top};});
  expect(geometry.labelY).toBeGreaterThan(geometry.codeY);if(name==='mobile')await page.locator('#order-rows .order-row-expanded [data-order-more-info]').click();
 }
 if(name==='desktop')await page.locator('[data-platform-status]').first().scrollIntoViewIfNeeded();else await page.locator('#order-rows [data-order-more-info]').first().click();await page.screenshot({path:'proofs/temu-status-labels-'+name+'.png',fullPage:true});
 expect(errors).toEqual([]);fs.writeFileSync('proofs/temu-status-labels-'+name+'.json',JSON.stringify({status:'PASS',viewport,codes:Object.keys(labels),errors}));
});
