import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=await fs.readFile(new URL('../public/stock-information.js',import.meta.url),'utf8');
async function check({expired=true,hidden=false,viewHidden=false,empty=false}={}){
 let tick,calls=0;const info={isConnected:true,dataset:{stockInformation:'TEST',expiresAt:String(Date.now()+(expired?-1000:60000))},textContent:'unchanged',innerHTML:''};
 const root={querySelectorAll:selector=>selector.includes('data-expires-at')&&!empty?[info]:[]};
 const data={original:{incoming:2},equivalents:[],equivalentCount:0,locationId:'test',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 const context={document:{hidden,getElementById:id=>id==='order-rows'?root:{hidden:viewHidden}},window:{},IntersectionObserver:class{observe(){}unobserve(){}},MutationObserver:class{observe(){}},setInterval:fn=>tick=fn,setTimeout:()=>1,clearTimeout(){},URLSearchParams,esc:String,api:async()=>{calls++;return data;}};
 vm.runInNewContext(source,context);tick();await new Promise(resolve=>setImmediate(resolve));
 const shouldRead=expired&&!hidden&&!viewHidden&&!empty;
 assert.equal(calls,shouldRead?1:0);if(shouldRead){assert.match(info.innerHTML,/2/);assert.ok(Number(info.dataset.expiresAt)>Date.now());tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);}else assert.equal(info.textContent,'unchanged');
}
for(const input of [{},{expired:false},{hidden:true},{viewHidden:true},{empty:true}])await check(input);
console.log('PASS: expired refresh, future expiry, hidden document, hidden view, empty table; no duplicate call after refreshed expiry. No network or business writes.');
