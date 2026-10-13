import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const server=await readFile(path.join(root,'src/server.mjs'),'utf8');
const start=server.indexOf("if(req.method==='GET'&&['/',");
const end=server.indexOf("if(p==='/api/status'",start);
assert.ok(start>=0&&end>start,'Production static handler found');
const handler=new (Object.getPrototypeOf(async function(){}).constructor)('req','p','res','readFile','path','root',server.slice(start,end));
async function request(route,method='GET'){
 const response={headers:{},setHeader(k,v){this.headers[k]=v;},end(bytes){this.bytes=bytes;}};
 await handler({method},route,response,readFile,path,root);return response;
}
test('every entry-page script and stylesheet is served by the production handler without authentication',async()=>{
 const html=await readFile(path.join(root,'public/index.html'),'utf8');
 const assets=[...html.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css))(?:[?#][^"]*)?"/g)].map(x=>x[1]);
 assert.ok(assets.includes('/temu-excel-preparation.js'));
 for(const asset of new Set(assets)){
  const response=await request(asset);
  assert.ok(response.bytes,asset+' was not served');
  assert.deepEqual(response.bytes,await readFile(path.join(root,'public',asset.slice(1))),asset);
  assert.equal(response.headers['Content-Type'],asset.endsWith('.js')?'text/javascript':'text/css',asset);
 }
});
test('static handler rejects unknown, private and traversing paths and non-GET requests',async()=>{
 for(const route of ['/missing.js','/src/server.mjs','/../src/server.mjs','/application.env'])assert.equal((await request(route)).bytes,undefined);
 assert.equal((await request('/temu-excel-preparation.js','POST')).bytes,undefined);
});
