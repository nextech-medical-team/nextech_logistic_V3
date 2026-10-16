import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/problem-corrections.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('function temuRefusalDetailsHtml('),source.indexOf('function invalidateResolutionContextReads('));
const ctx={esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
vm.createContext(ctx);vm.runInContext(helper,ctx);
test('refusal dialog shows exact reasons for every refused parcel, safely escaped',()=>{
 const html=ctx.temuRefusalDetailsHtml({type:'temu-label-refused'},{temuJob:{refusalReasons:[{packageSn:'PK-1',reason:'Address contains <unsupported> characters'},{packageSn:'PK-2',reason:'Destination not supported'}]}});
 assert.match(html,/PK-1/);assert.match(html,/&lt;unsupported&gt;/);assert.match(html,/PK-2/);assert.match(html,/Destination not supported/);
 assert.doesNotMatch(html,/<unsupported>/);
});
test('missing original reason is explicit and other diagnostics remain unchanged',()=>{
 assert.match(ctx.temuRefusalDetailsHtml({type:'temu-label-refused'},{}),/ne fournit pas/);
 assert.equal(ctx.temuRefusalDetailsHtml({type:'weight'},{}),'');
});
