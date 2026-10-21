import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/review.js',import.meta.url),'utf8');
const formatter=await readFile(new URL('../public/compact-problems.js',import.meta.url),'utf8');
const handlers=source.slice(source.indexOf('// Verify only on explicit request;'),source.lastIndexOf('})();'));
function fixture(api){
 let onVisibility;const renders=[],reads=[],attributes={};
 const context={MutationObserver:class{constructor(callback){onVisibility=callback;}observe(){}},panel:{hidden:false,setAttribute:(key,value)=>attributes[key]=value},button:{disabled:false,textContent:'Lancer la vérification'},verifyButtonLabel:'Lancer la vérification',displayedRows:[],exportRows:[],exportButton:{disabled:false},searchCount:{textContent:''},status:{textContent:''},table:{hidden:false},body:{},loadHistory:async()=>{reads.push('history');},emptyRow:()=>{},renderRows:rows=>renders.push(rows),api:(...args)=>{reads.push(args);return api(...args);},URLSearchParams,Date,Set};
 vm.createContext(context);vm.runInContext(formatter,context);vm.runInContext(handlers,context);
 return {context,renders,reads,attributes,open:()=>onVisibility()};
}
test('opening and reopening the module reads reports without launching an ERP scan',()=>{
 const f=fixture(()=>{throw Error('Unexpected scan');});f.open();f.open();
 assert.deepEqual(f.reads,['history','history']);assert.equal(f.context.button.disabled,false);
});
test('click scans all pages once, blocks double clicks and restores the button',async()=>{
 let release;const first=new Promise(resolve=>release=resolve);
 const f=fixture(async(url,{page,runId})=>{assert.equal(url,'/api/stocks/negative/scan');if(page===1){assert.equal(runId,null);await first;}else assert.equal(runId,'report');return {page,lastPage:2,locationId:'7',runId:'report',unverified:0,rows:[{bcId:'CO'+page,available:-1}]};});
 const pending=f.context.button.onclick();
 assert.equal(f.context.button.disabled,true);assert.equal(f.attributes['aria-busy'],'true');
 await f.context.button.onclick();release();await pending;
 assert.equal(f.reads.filter(entry=>Array.isArray(entry)).length,2);assert.equal(f.renders[0].length,2);
 assert.equal(f.context.button.disabled,false);assert.equal(f.attributes['aria-busy'],'false');assert.equal(f.context.button.textContent,'Lancer la vérification');
});
test('failed click restores the button and allows a retry without rendering false results',async()=>{
 const f=fixture(async()=>{throw Error('Network failure');});
 await f.context.button.onclick();assert.equal(f.context.button.disabled,false);assert.equal(f.renders.length,0);assert.match(f.context.status.textContent,/Network failure/);
 await f.context.button.onclick();assert.equal(f.reads.filter(entry=>Array.isArray(entry)).length,2);
});
