import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/tracking-sync.js',import.meta.url),'utf8');
function setup({ids=['order-1'],deliveries=[],active=false,race=false,clearDuringRead=false}={}){
 const elements=new Map(),requests=[],created=[];
 const element=()=>({textContent:'',hidden:false,disabled:false,elements:{search:{value:''}},setAttribute(){},addEventListener(){},after(){}});
 const find=key=>{if(!elements.has(key))elements.set(key,element());return elements.get(key);};
 const panel={...element(),open:false,querySelector:find,showModal(){},close(){}};
 const selected=new Set(ids);
 const context={document:{getElementById:()=>element(),createElement:tag=>{const e=tag==='dialog'?panel:element();created.push(e);return e;},body:{append(){}}},
  user:{role:'admin'},selected,selectedDeliveries:new Set(deliveries),URLSearchParams,
  setInterval(){},setTimeout(){},clearTimeout(){},
  api:async(url,body)=>{
   requests.push({url,body});
   if(body)return {run:{id:'new-run'},existing:race};
   if(clearDuringRead)selected.clear();
   return {runs:active?[{id:'other-run',status:'running'}]:[],canApply:false,workerAvailable:true};
  }};
 vm.runInNewContext(source,context);
 return {requests,find,launch:find('[data-again]').onclick};
}

test('selection is captured before network wait and results are scoped to the new run',async()=>{
 const ui=setup({ids:['order-1','order-2'],clearDuringRead:true});await ui.launch();
 const posts=ui.requests.filter(r=>r.body);
 assert.equal(posts.length,1);assert.deepEqual(Array.from(posts[0].body.ids),['order-1','order-2']);
 assert.ok(ui.requests.some(r=>r.url.includes('run=new-run')));
});
test('empty selection never submits a global synchronization',async()=>{
 const ui=setup({ids:[]});await ui.launch();assert.equal(ui.requests.length,0);
 assert.match(ui.find('[data-error]').textContent,/Cochez au moins une commande/);
});
test('five selected orders are sent unchanged',async()=>{
 const ids=['a','b','c','d','e'],ui=setup({ids});await ui.launch();
 assert.deepEqual(Array.from(ui.requests.find(r=>r.body).body.ids),ids);
});
test('six selected orders are rejected without submitting any request',async()=>{
 const ui=setup({ids:['a','b','c','d','e','f']});await ui.launch();
 assert.equal(ui.requests.length,0);assert.match(ui.find('[data-error]').textContent,/5 commandes maximum/);
});
test('partial delivery selection cannot silently become a global synchronization',async()=>{
 const ui=setup({ids:[],deliveries:['partial-1']});await ui.launch();assert.equal(ui.requests.length,0);
 assert.match(ui.find('[data-error]').textContent,/commandes principales/);
});
test('existing global run is not submitted as a test of the selection',async()=>{
 const ui=setup({active:true});await ui.launch();assert.equal(ui.requests.filter(r=>r.body).length,0);
 assert.match(ui.find('[data-error]').textContent,/Aucune demande lancée/);
});
test('concurrent run returned by the server is not displayed as the selected run',async()=>{
 const ui=setup({race:true});await ui.launch();assert.equal(ui.requests.length,2);
 assert.match(ui.find('[data-error]').textContent,/démarrer ailleurs/);
});
