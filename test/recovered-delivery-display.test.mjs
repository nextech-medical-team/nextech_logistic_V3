import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('display grouping follows recovery origin even after label completion',async()=>{
 const source=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
 const start=source.indexOf("if(p==='/api/partial/visible'");
 const route=source.slice(start,source.indexOf("if(p==='/api/partial/list'",start));
 const expression=route.match(/(\(coalesce\(d\.request_id LIKE [\s\S]+?) AS recovered_existing_bl/)[1];
 const db=new PGlite();await db.waitReady;
 try{
  const {rows}=await db.query(`SELECT d.id, ${expression} AS grouped FROM (VALUES
   ('normal','random-uuid','new','ready'),
   ('recovered-pending','recovered-bl:order:bl','new','recovered_bl'),
   ('recovered-ready','recovered-bl:order:bl','new','ready'),
   ('associated-bl','random-uuid','existing_bl','ready'),
   ('legacy',NULL,'new','ready')
  ) AS d(id,request_id,label_choice,stage)`);
  assert.deepEqual(Object.fromEntries(rows.map(r=>[r.id,r.grouped])),{normal:false,'recovered-pending':true,'recovered-ready':true,'associated-bl':true,legacy:false});
 }finally{await db.close();}
});
