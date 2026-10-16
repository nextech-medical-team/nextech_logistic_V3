import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/margins.js',import.meta.url),'utf8');
const paint=source.slice(source.indexOf('function paintMarginChip('),source.indexOf('function temuBadges('));

test('delivered orders without a complete margin stop mutating after the observer repaints',()=>{
 for(const margin of [undefined,{status:'incomplete'}]){
  let text='FR',writes=0,empty=null,chip={remove(){chip=null;}};
  const target={closest:()=>({dataset:{orderDelivered:'true'}}),querySelector:s=>s==='[data-margin-chip]'?chip:empty,
   hasAttribute:()=>false,append(node){writes++;empty=node;},
   get textContent(){return text;},set textContent(value){assert.fail('Country must remain present');}};
  const document={createElement:()=>({dataset:{},textContent:'',remove(){empty=null;}})};
  const context={target,margin,document};vm.createContext(context);vm.runInContext(paint,context);
  vm.runInContext('paintMarginChip(target,margin,"fixture")',context);
  assert.equal(text,'FR');assert.equal(empty.textContent,'—');assert.equal(chip,null);assert.equal(writes,1);
  // Each DOM write would enqueue another MutationObserver callback.
  for(let i=0;i<10;i++)vm.runInContext('paintMarginChip(target,margin,"fixture")',context);
  assert.equal(writes,1,'observer repaint must settle without further DOM writes');
 }
});
