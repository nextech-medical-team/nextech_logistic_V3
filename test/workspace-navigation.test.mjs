import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const persistence=source.slice(source.indexOf('// Persist the active workspace module'),source.indexOf('// End workspace navigation persistence.'));
function fixture({hash='',role='admin',readyState='complete',stored=null}={}){
 const views=['orders','negative-stocks','stocks','users','audit','imports','import-shopify'].map(id=>({id:'view-'+id,hidden:id!=='orders'}));
 const store=new Map(stored?[['v3.workspace.view:test@example.com',stored]]:[]),listeners={};
 const context={user:{email:'test@example.com',role},URLSearchParams,location:{hash,pathname:'/',search:''},history:{state:null,replaceState(state,title,url){context.location.hash=new URL(url,'http://fixture').hash;}},sessionStorage:{getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value)},MutationObserver:class{observe(){}},$:()=>({hidden:false}),document:{readyState,getElementById:id=>views.find(view=>view.id===id),querySelector:()=>({hidden:false}),querySelectorAll:()=>views,addEventListener:(name,handler)=>{(listeners[name]??=[]).push(handler);}},show:async id=>{views.forEach(view=>view.hidden=view.id!=='view-'+id);}};
 vm.createContext(context);vm.runInContext(persistence,context);
 return {context,views,store,listeners,run:code=>vm.runInContext(code,context)};
}
test('refresh restores a module and subsequent navigation updates the saved page',async()=>{
 const f=fixture({hash:'#view=negative-stocks'});
 await f.run('restoreWorkspaceView()');
 assert.equal(f.views.find(view=>!view.hidden).id,'view-negative-stocks');
 await f.context.show('stocks');f.run('saveWorkspaceView()');
 assert.equal(f.context.location.hash,'#view=stocks');
 assert.equal(f.store.get('v3.workspace.view:test@example.com'),'stocks');
});
test('restoration waits for module registration and supports session fallback',async()=>{
 const f=fixture({readyState:'loading',stored:'negative-stocks'});
 const restored=f.run('restoreWorkspaceView()');
 assert.equal(f.views.find(view=>!view.hidden).id,'view-orders');
 f.listeners.DOMContentLoaded.forEach(handler=>handler());await restored;
 assert.equal(f.views.find(view=>!view.hidden).id,'view-negative-stocks');
});
test('unknown and unauthorized modules fall back to orders',async()=>{
 for(const view of ['missing','users','audit','imports']){
  const f=fixture({hash:'#view='+view,role:'viewer'});await f.run('restoreWorkspaceView()');
  assert.equal(f.views.find(view=>!view.hidden).id,'view-orders');
 }
});
