import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const script=readFileSync(new URL('../public/manual-platform-cancellation.js',import.meta.url),'utf8');
for(const layout of ['actions','filters','parent','absent'])test('cancellation control initializes with '+layout+' layout without source calls',()=>{
 const created=[],inserted=[],calls=[];
 const container={after(element){inserted.push(['report',element]);}};
 const anchor=layout==='absent'?null:{parentElement:container,closest(selector){return selector===(layout==='actions'?'.order-filter-actions':layout==='filters'?'.filters':'none')?container:null;},after(element){inserted.push(['button',element]);}};
 const document={createElement(tag){const element={tag,attributes:{},setAttribute(key,value){this.attributes[key]=value;}};created.push(element);return element;}};
 runInNewContext(script,{$:()=>anchor,document,api:()=>calls.push('api'),orders:()=>calls.push('orders')});
 assert.deepEqual(calls,[]);
 if(layout==='absent'){assert.equal(created.length,0);return;}
 assert.equal(inserted.length,2);assert.equal(inserted[0][1].id,'platform-cancellation-refresh');assert.equal(typeof inserted[0][1].onclick,'function');assert.equal(inserted[1][1].attributes.role,'status');
});
