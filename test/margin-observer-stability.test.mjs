import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../public/margins.js',import.meta.url),'utf8');
const paint=source.slice(source.indexOf('function paintMarginChip('),source.indexOf('function temuBadges('));

test('delivered orders without a complete margin stop mutating after the observer repaints',()=>{
 for(const margin of [undefined,{status:'incomplete'}]){
  let text='Old margin',writes=0,chip={remove(){chip=null;}};
  const target={closest:()=>({dataset:{orderDelivered:'true'}}),querySelector:()=>chip,
   get textContent(){return text;},set textContent(value){writes++;text=value;}};
  const context={target,margin};vm.createContext(context);vm.runInContext(paint,context);
  vm.runInContext('paintMarginChip(target,margin,"fixture")',context);
  assert.equal(text,'—');assert.equal(chip,null);assert.equal(writes,1);
  // Each DOM write would enqueue another MutationObserver callback.
  for(let i=0;i<10;i++)vm.runInContext('paintMarginChip(target,margin,"fixture")',context);
  assert.equal(writes,1,'observer repaint must settle without further DOM writes');
 }
});
