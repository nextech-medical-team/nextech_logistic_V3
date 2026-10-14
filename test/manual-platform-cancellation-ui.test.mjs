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
 return {calls,context,oldView,title,nav,orders,settings,settingsBody,find:id=>elements.find(el=>el.id===id)};
}
test('menu opens dedicated page without a platform call or cancellation',async()=>{
 const f=fixture(),menu=f.find('platform-cancellations-menu'),panel=f.find('view-platform-cancellations');
 assert.ok(f.settingsBody.children.includes(menu));assert.equal(f.settings.open,true);assert.equal(panel.hidden,true);assert.deepEqual(f.calls,[]);
 await menu.onclick();assert.equal(panel.hidden,false);assert.equal(f.oldView.hidden,true);assert.equal(f.context.currentView,'platform-cancellations');assert.equal(f.title.textContent,'Annulations Temu / Shopify');assert.deepEqual(f.calls,[]);
 await f.context.show('products');assert.deepEqual(f.calls,[['show','products']]);
});
test('verification starts only after clicking Actualiser on its page',async()=>{
 const f=fixture();await f.find('platform-cancellations-menu').onclick();await f.find('platform-cancellation-refresh').onclick();
 assert.equal(f.calls[0][0],'api');assert.equal(f.calls[0][1],'/api/orders/refresh-platform-cancellations');assert.equal(f.calls[1][0],'orders');assert.equal(f.find('platform-cancellation-refresh').disabled,false);
});
test('menu initializes without the reload control or orders menu',()=>{const f=fixture({hasOrders:false});assert.ok(f.settingsBody.children.includes(f.find('platform-cancellations-menu')));assert.deepEqual(f.calls,[]);});
test('missing application surface does not throw or call sources',()=>{const f=fixture({hasMain:false});assert.equal(f.find('platform-cancellations-menu'),undefined);assert.deepEqual(f.calls,[]);});
