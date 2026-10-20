import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../public/partial.js',import.meta.url),'utf8');
function reader(api){const context={api,Map,Date,Promise,setInterval:()=>1,clearInterval:()=>{},setTimeout:fn=>{fn();return 1;}};vm.createContext(context);vm.runInContext(src.slice(src.indexOf('const partialPreviewReads='),src.indexOf('const baseDetail='))+src.slice(src.indexOf('async function readPartialPreview'),src.indexOf('function cachedPartialPreview')),context);return context;}
test('a late shared read still resolves and concurrent refresh does not add a provider call',async()=>{let resolve,calls=0;const c=reader(()=>{calls++;return new Promise(r=>resolve=r);});const a=c.readPartialPreview('o',()=>{}),b=c.readPartialPreview('o',()=>{});assert.equal(calls,1);resolve({stock:12000});assert.equal((await a).stock,12000);assert.equal((await b).stock,12000);assert(!src.includes('Lecture Erplain toujours en attente après 60 s'));});
test('read-only temporary quota errors retry at most three times',async()=>{let calls=0;const c=reader(async()=>{calls++;throw Error('Erplain HTTP 429 · attente du quota partagé différée');});await assert.rejects(c.readPartialPreview('o',()=>{}),/429/);assert.equal(calls,3);});
test('read retry eventually returns stock; validation failures and closed views are not retried',async()=>{let calls=0;const c=reader(async()=>{if(++calls===1)throw Object.assign(Error('gateway'),{status:503});return {stock:12000};});assert.equal((await c.readPartialPreview('o',()=>{})).stock,12000);assert.equal(calls,2);for(const [message,current] of [['BC prix différents',true],['Erplain HTTP 429',false]]){let n=0;const x=reader(async()=>{n++;throw Error(message);});await assert.rejects(x.readPartialPreview('o',()=>{},()=>current));assert.equal(n,1);}});

for(const hasReadingStatus of [true,false])test('actual partial dialog retains HTTP error detail with reading status '+hasReadingStatus,async()=>{
 const node=()=>({textContent:'',append(){}}),content=node(),status=hasReadingStatus?node():null,stocks=[node(),node()];
 const nodes={'partial-content':content,'partial-reading':status,'partial-order':node()};
 const error=Object.assign(Error('Erreur de lecture synthétique'),{status:400});
 const context={user:{role:'admin'},currentView:'orders',partialPreviewVersion:0,partialDraft:{id:'old'},
  dialog:{close(){}},partialDialog:{open:true,querySelectorAll:()=>stocks,showModal(){}},
  $:id=>nodes[id],document:{createElement:()=>node()},
  partialVisibleOrders:new Map([['o',{}]]),cachedPartialPreview:()=>({}),renderPartialForm(){},
  readPartialPreview:async()=>{throw error;}};
 vm.createContext(context);
 vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),context);
 vm.runInContext(src.slice(src.indexOf('async function openPartial('),src.indexOf('function renderPartialForm(')),context);
 await context.openPartial('o');
 const text=(status||content).textContent;
 assert.match(text,/HTTP 400/);assert.match(text,/Erreur de lecture synthétique/);
 assert.match(text,/Vos quantités sont conservées/);
 assert.ok(stocks.every(cell=>cell.textContent==='Stock non vérifié'));
 assert.equal(context.partialDraft,null);assert.equal(error.message,'Erreur de lecture synthétique');
});
