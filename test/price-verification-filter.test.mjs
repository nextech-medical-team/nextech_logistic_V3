import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('percentage filters support greater, less, equal, clearing and unavailable results',()=>{
 const rows=[-10,0,10,null].map(percent=>({dataset:{result:'true',percent:percent==null?'':String(percent)},hidden:false}));
 const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,validity:{valid:true},children:[],append(){}});return elements.get(id);};
 element('prices-rows').children=rows;element('prices-operator').value='all';
 vm.runInNewContext(readFileSync(new URL('../public/price-verification.js',import.meta.url),'utf8'),{document:{createElement:()=>({dataset:{}}),querySelectorAll:()=>[],querySelector:()=>({append(){}}),head:{append(){}}},addView(){},$:element,Intl});
 const visible=()=>rows.filter(row=>!row.hidden).map(row=>row.dataset.percent);
 element('prices-percent').value='0';
 element('prices-operator').value='gt';element('prices-operator').onchange();assert.deepEqual(visible(),['10']);
 element('prices-operator').value='lt';element('prices-operator').onchange();assert.deepEqual(visible(),['-10']);
 element('prices-operator').value='eq';element('prices-operator').onchange();assert.deepEqual(visible(),['0']);
 element('prices-percent').value='-10';element('prices-percent').oninput();assert.deepEqual(visible(),['-10']);
 element('prices-percent').value='';element('prices-percent').oninput();assert.equal(visible().length,4);
 element('prices-operator').value='all';element('prices-operator').onchange();assert.equal(element('prices-percent').disabled,true);assert.equal(visible().length,4);
});
