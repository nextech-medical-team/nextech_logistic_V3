import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const script=readFileSync(new URL('../public/manual-platform-cancellation.js',import.meta.url),'utf8');
function fixture({hasOrders=true,hasMain=true}={}){
 const elements=[],calls=[],oldView={id:'view-orders',hidden:false},title={textContent:''};
 const create=tag=>{const el={tag,children:[],dataset:{},attributes:{},classList:{toggle(){}},append(...nodes){this.children.push(...nodes);},after(node){this.afterNode=node;},replaceChildren(){this.children=[];},setAttribute(k,v){this.attributes[k]=v;}};elements.push(el);return el;};
 const main=create('main'),nav=create('nav'),orders=create('button'),settings=create('details'),settingsBody=create('div');orders.dataset.view='orders';nav.querySelector=()=>hasOrders?orders:null;
 settings.open=false;settings.querySelector=s=>s==='summary'?{textContent:'Paramètres'}:settingsBody;
 const document={createElement:create,querySelector:s=>s==='main'?(hasMain?main:null):s==='nav'?nav:null,querySelectorAll:s=>s==='nav .nav-group'?[settings]:s==='.view'?[oldView,...elements.filter(el=>el.className==='view')]:elements.filter(el=>el.dataset.view)};
 const context={document,$:id=>id==='title'?title:null,currentView:'orders',show:async view=>calls.push(['show',view]),api:async(...args)=>{calls.push(['api',...args]);return {done:true};},orders:async()=>calls.push(['orders'])};
 runInNewContext(script,context);
 return {calls,context,oldView,title,nav,orders,settings,settingsBody,find:id=>elements.findLast(el=>el.id===id)};
}
test('menu loads saved history without consulting platforms or applying cancellations',async()=>{
 const f=fixture(),menu=f.find('platform-cancellations-menu'),panel=f.find('view-platform-cancellations');
 assert.ok(f.settingsBody.children.includes(menu));assert.equal(f.settings.open,true);assert.equal(panel.hidden,true);assert.deepEqual(f.calls,[]);
 await menu.onclick();assert.equal(panel.hidden,false);assert.equal(f.oldView.hidden,true);assert.equal(f.context.currentView,'platform-cancellations');assert.equal(f.title.textContent,'Annulations Temu / Shopify');assert.deepEqual(f.calls,[['api','/api/orders/platform-cancellations/history']]);
 await f.context.show('products');assert.deepEqual(f.calls,[['api','/api/orders/platform-cancellations/history'],['show','products']]);
});
test('verification starts only after clicking Actualiser on its page',async()=>{
 const f=fixture();await f.find('platform-cancellations-menu').onclick();await f.find('platform-cancellation-refresh').onclick();
 assert.equal(f.calls[1][0],'api');assert.equal(f.calls[1][1],'/api/orders/refresh-platform-cancellations');assert.equal(f.calls.length,2);assert.equal(f.find('platform-cancellation-refresh').disabled,false);
});
test('menu initializes without the reload control or orders menu',()=>{const f=fixture({hasOrders:false});assert.ok(f.settingsBody.children.includes(f.find('platform-cancellations-menu')));assert.deepEqual(f.calls,[]);});

test('saved report reopens and application saves the same report',async()=>{
 const f=fixture(),calls=[];
 f.context.api=async(url,input)=>{
  calls.push([url,input]);
  if(url.endsWith('/history'))return {rows:[{id:'report-1',created_at:'2026-10-16T09:00:00Z',status:'ready'}]};
  if(url.includes('/report?id='))return {id:'report-1',created_at:'2026-10-16T09:00:00Z',status:'ready',scope:{channels:['temu']},scan_complete:true,issues:[],results:[{id:'a',channel:'temu',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:false}]};
  if(url.endsWith('/apply-platform-cancellations'))return {result:{id:'a',channel:'temu',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:true,applied:true}};
  if(url.endsWith('/finish'))return {saved:true};
  throw Error('Unexpected API '+url);
 };
 await f.find('platform-cancellations-menu').onclick();
 const history=f.find('platform-cancellation-history');assert.equal(history.children.length,2);
 history.value='report-1';await history.onchange();
 assert.equal(f.find('platform-cancellation-apply').disabled,false);
 await f.find('platform-cancellation-apply').onclick();
 assert.equal(calls.find(([url])=>url.endsWith('/apply-platform-cancellations'))[1].reportId,'report-1');
 assert.equal(calls.find(([url])=>url.endsWith('/finish'))[1].reportId,'report-1');
 assert.equal(f.find('platform-cancellation-apply').disabled,true);
 assert.ok(!calls.some(([url])=>url.endsWith('/refresh-platform-cancellations')));
});
test('missing application surface does not throw or call sources',()=>{const f=fixture({hasMain:false});assert.equal(f.find('platform-cancellations-menu'),undefined);assert.deepEqual(f.calls,[]);});

test('report table is visible before verification with headings and an empty state',()=>{
 const f=fixture(),table=f.find('platform-cancellation-results');assert.ok(table);
 const head=table.children.find(el=>el.tag==='thead').children[0];
 assert.deepEqual(Array.from(head.children,el=>el.textContent),['Plateforme','Référence commande','Pays','Annulée sur Temu / Shopify','Annulée dans V3','Résultat','Compte rendu']);
 const empty=table.children.find(el=>el.tag==='tbody').children[0].children[0];
 assert.equal(empty.attributes.colspan,'7');assert.match(empty.textContent,/Aucun compte rendu/);assert.equal(f.calls.length,0);
});

test('table remains visible while verification is running and displays the resulting detail',async()=>{
 const f=fixture();let finish;f.context.api=()=>new Promise(resolve=>{finish=resolve;});
 const pending=f.find('platform-cancellation-refresh').onclick();
 assert.match(f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children[0].textContent,/Vérification en cours/);
 f.context.api=async()=>({done:true});finish({done:false,cursor:'a',result:{channel:'shopify',reference:'REF-42',status:'review',error:'Stock à rapprocher'}});await pending;
 const cells=f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children;
 assert.equal(cells[0].textContent,'Shopify');assert.equal(cells[1].textContent,'REF-42');assert.equal(cells[5].children[0].textContent,'À vérifier');assert.equal(cells[6].textContent,'Stock à rapprocher');
});

for(const [selection,channels] of [['temu',['temu']],['shopify',['shopify']],['both',['temu','shopify']]]){
 test('selection '+selection+' persists through navigation and is sent for every request',async()=>{
  const f=fixture();f.find('platform-cancellation-channels').value=selection;
  let count=0;f.context.api=async(url,input)=>{if(url.endsWith('/history'))return {rows:[]};assert.deepEqual(Array.from(input.channels),channels);return count++===0?{done:false,cursor:'a',result:{channel:channels[0],reference:'REF',status:'cancelled'}}:{done:true};};
  await f.find('platform-cancellations-menu').onclick();await f.find('platform-cancellation-refresh').onclick();
  const report=f.find('platform-cancellation-report'),summary=report.children[0].textContent;
  assert.match(summary,/1 commandes vérifiées/);assert.equal(f.find('platform-cancellation-export').disabled,false);
  await f.context.show('products');await f.find('platform-cancellations-menu').onclick();
  assert.equal(report.children[0].textContent,summary);assert.equal(count,2);
 });
}
test('Excel button downloads displayed results without running verification again',async()=>{
 const f=fixture();let count=0;f.context.api=async()=>count++===0?{done:false,cursor:'a',result:{channel:'temu',reference:'REF',status:'review',error:'À vérifier'}}:{done:true};
 await f.find('platform-cancellation-refresh').onclick();
 let payload,downloaded=false;f.context.fetch=async(url,options)=>{assert.equal(url,'/api/orders/platform-cancellations/export');payload=JSON.parse(options.body);return {ok:true,blob:async()=>({})};};
 f.context.URL={createObjectURL:()=> 'blob:export',revokeObjectURL(){}};f.context.setTimeout=fn=>fn();f.context.document.body={append(link){link.click=()=>{downloaded=true;assert.match(link.download,/\.xlsx$/);};link.remove=()=>{};}};
 await f.find('platform-cancellation-export').onclick();assert.equal(payload.results[0].reference,'REF');assert.equal(downloaded,true);assert.equal(count,2);
});

test('refresh previews cancellations and Apply alone calls the application endpoint',async()=>{
 const f=fixture(),apply=f.find('platform-cancellation-apply');assert.equal(apply.disabled,true);
 let reads=0;f.context.api=async(url)=>{assert.equal(url,'/api/orders/refresh-platform-cancellations');return reads++===0?{done:false,cursor:'a',result:{id:'a',channel:'temu',reference:'REF',status:'cancelled'}}:{done:true};};
 await f.find('platform-cancellation-refresh').onclick();assert.equal(apply.disabled,false);
 const detail=()=>f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children[6].textContent;
 assert.match(detail(),/appliquer/);
 let writes=0;f.context.api=async(url,input)=>{writes++;assert.equal(url,'/api/orders/apply-platform-cancellations');assert.equal(input.id,'a');assert.deepEqual(Array.from(input.channels),['temu']);return {result:{id:'a',channel:'temu',reference:'REF',status:'cancelled',applied:true}};};
 await apply.onclick();assert.equal(writes,1);assert.equal(apply.disabled,true);assert.match(detail(),/appliqu.e dans V3/);
 await apply.onclick();assert.equal(writes,1);
});

test('an interrupted refresh keeps Apply disabled',async()=>{
 const f=fixture();let reads=0;f.context.api=async()=>{if(reads++)throw Error('Source unavailable');return {done:false,cursor:'a',result:{id:'a',channel:'temu',reference:'REF',status:'cancelled'}};};
 await f.find('platform-cancellation-refresh').onclick();assert.equal(f.find('platform-cancellation-apply').disabled,true);
});

test('table exposes cancellation confirmed on platform but not in V3',async()=>{
 const f=fixture();let page=0;f.context.api=async()=>page++===0?{done:false,cursor:'a',result:{id:'a',channel:'temu',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:false}}:{done:true};
 await f.find('platform-cancellation-refresh').onclick();
 const cells=f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children;
 assert.equal(cells[3].textContent,'Oui');assert.equal(cells[4].textContent,'Non');
 assert.equal(cells[5].children[0].textContent,'Annulation plateforme confirmée — à appliquer dans V3');
 assert.equal(cells[5].children[0].className,'badge warn');
 assert.match(f.find('platform-cancellation-report').children[0].textContent,/0 annulées dans V3/);
 assert.equal(f.find('platform-cancellation-apply').disabled,false);
});

test('already cancelled V3 orders are counted separately and cannot be applied again',async()=>{
 const f=fixture();let page=0;
 f.context.api=async()=>page++===0?{done:false,cursor:'a',result:{id:'a',channel:'temu',reference:'REF',status:'cancelled',platformCancelled:true,v3Cancelled:true}}:{done:true};
 await f.find('platform-cancellation-refresh').onclick();
 const cells=f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children;
 assert.equal(cells[5].children[0].textContent,'Annulée dans V3');
 assert.match(f.find('platform-cancellation-report').children[0].textContent,/1 annulées dans V3/);
 assert.equal(f.find('platform-cancellation-apply').disabled,true);
});

test('calendar sends the same UTC creation range on every page and skips excluded orders',async()=>{
 const f=fixture();f.find('platform-cancellation-from').value='2026-10-14T00:00';
 let page=0,cutoff;f.context.api=async(_url,input)=>{cutoff??=input.createdTo;
  assert.equal(input.createdFrom,new Date('2026-10-14T00:00').toISOString());assert.equal(input.createdTo,cutoff);assert.ok(Math.abs(Date.now()-Date.parse(cutoff))<5000);assert.equal(f.find('platform-cancellation-to'),undefined);
  if(page++===0)return {done:false,cursor:'a',skipped:true,unknownDate:true};
  if(page===2)return {done:false,cursor:'b',result:{id:'b',reference:'IN-RANGE',channel:'temu',status:'cancelled'}};
  return {done:true};
 };
 await f.find('platform-cancellation-refresh').onclick();
 const report=f.find('platform-cancellation-report');assert.match(report.children[0].textContent,/1 commandes/);
 assert.ok(report.children.some(el=>/date de création inconnue/.test(el.textContent||'')));
 assert.equal(f.find('platform-cancellation-from').disabled,false);
});

test('future calendar date does not call the API',async()=>{
 const f=fixture();f.find('platform-cancellation-from').value='2999-10-15T00:00';
 await f.find('platform-cancellation-refresh').onclick();assert.equal(f.calls.length,0);
});

test('status filter shows only cancellations and retains full French country names',async()=>{
 const f=fixture();let page=0;
 const rows=[{id:'a',channel:'temu',reference:'CANCEL',status:'cancelled',country:'IT'},{id:'b',channel:'shopify',reference:'KEEP',status:'unchanged',country:'NL'}];
 f.context.api=async()=>page<rows.length?{done:false,cursor:rows[page].id,result:rows[page++]}:{done:true};
 await f.find('platform-cancellation-refresh').onclick();
 const filter=f.find('platform-cancellation-status');filter.value='cancelled';filter.onchange();
 const body=()=>f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody');
 assert.equal(body().children.length,1);assert.equal(body().children[0].children[1].textContent,'CANCEL');assert.equal(body().children[0].children[2].textContent,'Italie');
 filter.value='all';filter.onchange();assert.equal(body().children.length,2);assert.equal(body().children[1].children[2].textContent,'Pays-Bas');
 filter.value='review';filter.onchange();assert.match(body().children[0].children[0].textContent,/filtre/);
});
