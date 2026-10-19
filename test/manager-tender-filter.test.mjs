import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {orderQuery} from '../src/order-query.mjs';

test('AO manager filter includes native and Erplain AOs and excludes both when unchecked',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE orders(id text,reference text,channel text,erp_live jsonb,source_payload jsonb,archived boolean DEFAULT false,source_date text,received_at timestamptz DEFAULT now());`);
  const fixtures=[['native','tender',null],['31109693','erplain',"Appels d'offres"],['curly','erplain',' APPELS D’OFFRES '],['singular','erplain',"Appel d'offres"],['other','erplain','Commercial'],['missing','erplain',null],['temu','temu',null],['amazon','amazon',null],['shopify','shopify',null]];
  for(const [id,channel,label] of fixtures)await db.query('INSERT INTO orders(id,reference,channel,erp_live,source_payload) VALUES($1,$1,$2,$3,$4)',[id,channel,JSON.stringify({bc:{account_representative:{label}}}),'{}']);
  const read=async values=>{const q=orderQuery(new URLSearchParams(values.map(v=>['channel',v])));return (await db.query('SELECT id FROM orders '+q.where+' ORDER BY id',q.args)).rows.map(r=>r.id);};
  assert.deepEqual(await read(['tender']),['31109693','curly','native','singular']);
  assert.deepEqual(await read(['erplain']),['missing','other']);
  assert.deepEqual(await read(['erplain','temu','amazon_standard','shopify_boutique']),['amazon','missing','other','shopify','temu']);
  assert.equal((await read(['erplain','tender','temu'])).length,7);
  assert.equal((await read([])).length,9);
  const q=orderQuery(new URLSearchParams('channel=erplain&channel=temu'));
  const count=(await db.query('SELECT count(*)::int AS n FROM orders '+q.where,q.args)).rows[0].n;
  assert.equal(count,3);
  const paged=(await db.query('SELECT id FROM orders '+q.where+' ORDER BY id LIMIT 2 OFFSET 2',q.args)).rows;
  assert.deepEqual(paged,[{id:'temu'}]);
 }finally{await db.close();}
});
