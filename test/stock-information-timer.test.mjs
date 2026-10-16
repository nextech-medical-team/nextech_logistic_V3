import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await fs.readFile(new URL('../public/stock-information.js',import.meta.url),'utf8');
async function check({expired=true,hidden=false,viewHidden=false,empty=false}={}){
 const ticks=[];let calls=0;const info={isConnected:true,dataset:{stockInformation:'TEST',expiresAt:String(Date.now()+(expired?-1000:60000))},textContent:'unchanged',innerHTML:'',setAttribute(){},hasAttribute(){return false;},getBoundingClientRect(){return {top:1,bottom:20};}};
 const root={querySelectorAll:selector=>selector.includes('data-expires-at')&&!empty?[info]:[]};
 const data={original:{incoming:2},equivalents:[],equivalentCount:0,locationId:'test',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 const context={document:{hidden,getElementById:id=>id==='order-rows'?root:{hidden:viewHidden}},window:{innerHeight:1000},IntersectionObserver:class{observe(){}unobserve(){}},MutationObserver:class{observe(){}},setInterval:fn=>ticks.push(fn),setTimeout:()=>1,clearTimeout(){},URLSearchParams,esc:String,api:async()=>{calls++;return data;}};
 vm.runInNewContext(source,context);ticks.forEach(tick=>tick());await new Promise(resolve=>setImmediate(resolve));
 const shouldRead=expired&&!hidden&&!viewHidden&&!empty;
 assert.equal(calls,shouldRead?1:0);if(shouldRead){assert.match(info.innerHTML,/2/);assert.ok(Number(info.dataset.expiresAt)>Date.now());ticks.forEach(tick=>tick());await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);}else assert.equal(info.textContent,'unchanged');
}
for(const input of [{},{expired:false},{hidden:true},{viewHidden:true},{empty:true}])await check(input);
console.log('PASS: expired refresh, future expiry, hidden document, hidden view, empty table; no duplicate call after refreshed expiry. No network or business writes.');
const compact=await fs.readFile(new URL('../public/compact-problems.js',import.meta.url),'utf8');
const scope={esc:String};vm.createContext(scope);vm.runInContext(compact,scope);vm.runInContext("compactProblems=()=>[{type:'stock',sku:'TEST',detail:'Stock',label:'Stock'}]",scope);
for(const channel of ['tender','amazon','temu'])assert.match(scope.compactProblemButtons({id:'fixture',channel}),new RegExp('data-stock-channel="'+channel+'"'));
