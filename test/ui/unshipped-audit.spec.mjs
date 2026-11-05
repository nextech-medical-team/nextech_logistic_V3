import {test,expect} from '@playwright/test';
if(process.env.PLAYWRIGHT_CHROME_EXECUTABLE)test.use({launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROME_EXECUTABLE}});

const stamp='2026-11-05T12:00:00Z';
const row=(channel,reference,extra={})=>({channel,shop:channel==='temu'?'mall-fr':'test.myshopify.com',country:'FR',reference,date:'2026-10-28T10:00:00Z',ageDays:8,deadline:'2026-10-31T12:00:00Z',overdue:true,sourceKind:channel==='amazon'?'Rapport Amazon':'API '+channel.toUpperCase(),sourceStatus:channel==='temu'?'Non expédié':'UNFULFILLED',sourceAt:stamp,v3:[],bc:[],bl:[],parcels:[],errors:[],diagnosis:'Absente de V3',...extra});
async function setup(page){
 const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));let report=false;
 const rows=[row('temu','PO-069-1234567890',{v3:[{id:'one',labelStatus:'production_ready',blocker:null}],labelAvailable:true,bc:[{label:'C000001',status:'active'}],bl:[{label:'SHO000001',status:'ready_to_ship'}],erpAt:stamp,diagnosis:'Étiquette disponible ; suivi non confirmé',parcels:[{carrier:'gofo',tracking:'GFFR1234567890',observation:'unavailable',error:'API suivi · HTTP 429',lastKnown:{status:'delivered',checkedAt:'2026-10-20T12:00:00Z'}}]}),row('shopify','#13050'),row('amazon','123-1234567-1234567')];
 await page.route('**/api/unshipped-audit**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname.endsWith('/reports')){
   if(req.method()==='POST'){report=true;requests.push(req.postDataJSON());return route.fulfill({json:{id:'report-1',filename:'amazon.txt',count:1,excluded:0,errors:[],issues:[]}});}
   return route.fulfill({json:{reports:report?[{id:'report-1',filename:'amazon.txt',reported_at:stamp,count:1}]:[]}});
  }
  if(url.pathname.endsWith('/history'))return route.fulfill({json:{runs:[{id:'run-1',status:'partial',created_at:stamp,count:3}]}});
  if(req.method()==='POST'){requests.push(req.postDataJSON());return route.fulfill({status:202,json:{id:'run-1',status:'queued'}});}
  const filtered=rows.filter(r=>(!url.searchParams.get('channel')||r.channel===url.searchParams.get('channel'))&&(!url.searchParams.get('search')||r.reference.includes(url.searchParams.get('search'))));
  return route.fulfill({json:{id:'run-1',status:'partial',phase:'Contrôle terminé',options:{minAgeDays:3},startedAt:stamp,updatedAt:stamp,sourceCounts:{temu:10,shopify:5,amazon:1},coverage:[{channel:'temu',shop:'mall-fr',read:10,included:1,complete:true}],errors:[{scope:'Suivis',message:'GOFO : quota atteint'}],collected:3,total:filtered.length,page:1,pages:1,diagnoses:['Absente de V3','Étiquette disponible ; suivi non confirmé'],rows:filtered}});
 });
 await page.goto('/');await page.locator('nav [data-view="unshipped-audit"]').click();await expect(page.locator('#ua-rows tr')).toHaveCount(3);return {errors,requests};
}
for(const width of [1440,390])test('module non expédiées : résultats, limites et filtres à '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});const f=await setup(page);
 await expect(page.locator('#ua-rows')).toContainText('PO-069-1234567890');await expect(page.locator('#ua-rows')).toContainText('Suivi non confirmé');await expect(page.locator('#ua-rows')).toContainText('Dernière observation V3');await expect(page.locator('#ua-state')).toContainText('lectures incomplètes');
 await page.locator('#ua-channel').selectOption('shopify');await expect(page.locator('#ua-rows tr')).toHaveCount(1);await expect(page.locator('#ua-export')).toHaveAttribute('href',/channel=shopify/);
 await page.locator('#ua-channel').selectOption('');await page.locator('#ua-search').fill('13050');await expect(page.locator('#ua-rows tr')).toHaveCount(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:'/tmp/nextech-unshipped-audit-'+width+'.png',fullPage:true});expect(f.errors).toEqual([]);
});
test('rapport Amazon : chargement de contrôle, puis seuil et canaux transmis sans import métier',async({page})=>{
 const f=await setup(page);await page.locator('.ua-upload summary').click();await page.locator('#ua-file').setInputFiles({name:'amazon.txt',mimeType:'text/plain',buffer:Buffer.from('order-id\tpurchase-date\n123-1234567-1234567\t2026-10-20')});await page.locator('#ua-upload').click();await expect(page.locator('#ua-upload-state')).toContainText('prêt pour le contrôle');await expect(page.locator('#ua-amazon')).toBeChecked();await page.locator('#ua-age').fill('5');await page.locator('#ua-start').click();
 await expect.poll(()=>f.requests.length).toBe(2);expect(f.requests[1]).toEqual({channels:['temu','shopify','amazon'],minAgeDays:5,amazonReportId:'report-1'});expect(f.errors).toEqual([]);
});
