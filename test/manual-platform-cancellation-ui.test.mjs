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
test('menu opens dedicated page without a platform call or cancellation',async()=>{
 const f=fixture(),menu=f.find('platform-cancellations-menu'),panel=f.find('view-platform-cancellations');
 assert.ok(f.settingsBody.children.includes(menu));assert.equal(f.settings.open,true);assert.equal(panel.hidden,true);assert.deepEqual(f.calls,[]);
 await menu.onclick();assert.equal(panel.hidden,false);assert.equal(f.oldView.hidden,true);assert.equal(f.context.currentView,'platform-cancellations');assert.equal(f.title.textContent,'Annulations Temu / Shopify');assert.deepEqual(f.calls,[]);
 await f.context.show('products');assert.deepEqual(f.calls,[['show','products']]);
});
test('verification starts only after clicking Actualiser on its page',async()=>{
 const f=fixture();await f.find('platform-cancellations-menu').onclick();await f.find('platform-cancellation-refresh').onclick();
 assert.equal(f.calls[0][0],'api');assert.equal(f.calls[0][1],'/api/orders/refresh-platform-cancellations');assert.equal(f.calls.length,1);assert.equal(f.find('platform-cancellation-refresh').disabled,false);
});
test('menu initializes without the reload control or orders menu',()=>{const f=fixture({hasOrders:false});assert.ok(f.settingsBody.children.includes(f.find('platform-cancellations-menu')));assert.deepEqual(f.calls,[]);});
test('missing application surface does not throw or call sources',()=>{const f=fixture({hasMain:false});assert.equal(f.find('platform-cancellations-menu'),undefined);assert.deepEqual(f.calls,[]);});

test('report table is visible before verification with headings and an empty state',()=>{
 const f=fixture(),table=f.find('platform-cancellation-results');assert.ok(table);
 const head=table.children.find(el=>el.tag==='thead').children[0];
 assert.deepEqual(Array.from(head.children,el=>el.textContent),['Plateforme','Référence commande','Résultat','Compte rendu']);
 const empty=table.children.find(el=>el.tag==='tbody').children[0].children[0];
 assert.equal(empty.attributes.colspan,'4');assert.match(empty.textContent,/Aucun compte rendu/);assert.equal(f.calls.length,0);
});

test('table remains visible while verification is running and displays the resulting detail',async()=>{
 const f=fixture();let finish;f.context.api=()=>new Promise(resolve=>{finish=resolve;});
 const pending=f.find('platform-cancellation-refresh').onclick();
 assert.match(f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children[0].textContent,/Vérification en cours/);
 f.context.api=async()=>({done:true});finish({done:false,cursor:'a',result:{channel:'shopify',reference:'REF-42',status:'review',error:'Stock à rapprocher'}});await pending;
 const cells=f.find('platform-cancellation-results').children.find(el=>el.tag==='tbody').children[0].children;
 assert.equal(cells[0].textContent,'Shopify');assert.equal(cells[1].textContent,'REF-42');assert.equal(cells[2].children[0].textContent,'À vérifier');assert.equal(cells[3].textContent,'Stock à rapprocher');
});

for(const [selection,channels] of [['temu',['temu']],['shopify',['shopify']],['both',['temu','shopify']]]){
 test('selection '+selection+' persists through navigation and is sent for every request',async()=>{
  const f=fixture();f.find('platform-cancellation-channels').value=selection;
  let count=0;f.context.api=async(url,input)=>{assert.deepEqual(Array.from(input.channels),channels);return count++===0?{done:false,cursor:'a',result:{channel:channels[0],reference:'REF',status:'cancelled'}}:{done:true};};
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
