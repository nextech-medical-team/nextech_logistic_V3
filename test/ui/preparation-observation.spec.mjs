import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import {preparationMonitorView,projectPreparationActivity} from '../../src/preparation-observation-view.mjs';

for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]])test('preparation source diagnostics remain distinct '+name,async({page})=>{
 const now=Date.now(),at=new Date(now-1000).toISOString();
 const base={channel:'shopify',archived:false,simulation:false,recipient:'Synthetic recipient',address:{name:'Synthetic recipient',street:'1 rue Test',country:'FR',city:'Paris',postal:'75001'},source_date:at,line_count:1,item_quantity:300,sku_lines:[{sku:'TEST-SKU',source_sku:'TEST-SKU',quantity:300,mapping_exists:true}],label_status:'production_ready',tracking_status:'not_shipped',carrier:'gls',weight_kg:1,source_payload:{},erp_status:'live_review',erp_live_job:{status:'review'},erp_live:{}};
 const proof={schemaVersion:1,observedAt:at,expiresAt:new Date(now+898000).toISOString(),mappingVerified:true,business:[],technical:[],blocked:true,processing:{completed:false}};
 const rows=[
  {...structuredClone(base),id:'stock',reference:'TEST-STOCK',erp_live_job:{status:'review',error:'BC · Mapping manquant : TEST-SKU'},preparation_observation:{...proof,business:[{code:'stock-insufficient',message:'Stock insuffisant : TEST-SKU : 300 nécessaires ; stock disponible : 0'}]}},
  {...structuredClone(base),id:'technical',reference:'TEST-TECHNICAL',preparation_observation:{...proof,technical:[{code:'stock-unverifiable',message:'Stock non vérifiable : TEST-SKU'}]}},
  {...structuredClone(base),id:'continuation',reference:'TEST-CONTINUATION',preparation_observation:{...proof,processing:{continuationRequired:true},nextStep:'Produits et stock vérifiés ; autres prérequis à contrôler'}},
  {...structuredClone(base),id:'pending',reference:'TEST-PENDING',erp_live_job:{status:'pending'}},
  {...structuredClone(base),id:'processing',reference:'TEST-PROCESSING',erp_live_job:{status:'processing'},issue:'Adresse incomplète'},
  {...structuredClone(base),id:'cancelled',reference:'TEST-CANCELLED',label_status:'cancelled'}
 ];
 const processing=rows.map(row=>{
  const observation=row.preparation_observation;
  if(!observation)return {id:row.id,monitoring:null};
  const state={preparationObservation:observation,preparationObservedVersion:1,blocked:true,followUp:true,lastCheck:at,nextCheck:new Date(now+300000).toISOString(),result:'BC · Mapping manquant : TEST-SKU',nextStep:'Contrôler les sources'};
  return projectPreparationActivity({id:row.id,service:'Erplain',state:'blocked',reason:state.result,monitoring:preparationMonitorView(state,1,now)});
 });
 const writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(new URL(r.url()).pathname))writes.push(r.url());});
 await page.setViewportSize(viewport);
 await page.route(/\/api\/orders(?:\?|$)/,r=>r.fulfill({json:{rows,total:rows.length,page:1,pages:1,summary:{},transportStats:[]}}));
 await page.route('**/api/orders/processing',r=>r.fulfill({json:{at,rows:processing}}));await page.goto('/');
 const table=page.locator('#order-rows');await expect(table.locator('tr')).toHaveCount(6);
 const row=id=>table.locator('tr').filter({hasText:'TEST-'+id.toUpperCase()});
 await expect(row('stock').locator('.compact-problem').first()).toHaveAttribute('data-problem-type','stock');
 await expect(row('stock').locator('.compact-problem').first()).toHaveAttribute('data-problem-detail',/300 nécessaires.*stock disponible : 0/);
 await expect(row('stock').locator('.compact-problem[data-problem-type="mapping"]')).toHaveCount(0);
 await expect(row('technical').locator('.compact-problem').first()).toHaveAttribute('data-problem-type','api-stock');
 await expect(row('technical').locator('.compact-problem').first()).toHaveAttribute('data-problem-detail',/Stock non vérifiable/);
 await expect(row('continuation').locator('.compact-problem').first()).toContainText('Préparation à poursuivre');
 await expect(row('pending').locator('.compact-problem')).toHaveCount(0);
 await expect(row('processing').locator('.compact-problem').first()).toHaveAttribute('data-problem-detail',/Adresse incomplète/);
 await expect(row('cancelled').locator('.compact-problem')).toHaveCount(0);
 await expect(table.locator('.compact-problem[data-problem-type="erp-review"]')).toHaveCount(0);
 await expect(row('stock').locator('.monitoring-result')).toContainText('Stock insuffisant');
 await expect(row('technical').locator('.monitoring-result')).toContainText('Stock non vérifiable');
 for(const id of ['stock','technical']){await row(id).scrollIntoViewIfNeeded();await page.screenshot({path:'proofs/preparation-observation-'+id+'-'+name+'.png',fullPage:false});}
 expect(writes).toEqual([]);expect(errors).toEqual([]);
 fs.writeFileSync('proofs/preparation-observation-'+name+'.json',JSON.stringify({status:'PASS',viewport,cases:6,businessStock:true,technicalUnknownStock:true,obsoleteMappingRemoved:true,independentErrorPreserved:true,queuedNotBlocked:true,cancelledExcluded:true,writes,errors,scope:'Actual UI with synthetic source proofs; production verification remains required'}));
});
