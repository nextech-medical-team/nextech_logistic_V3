import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {currentReasonSql,currentReasonEmptySql} from '../src/current-order-diagnostics.mjs';
test('Merged source/carrier rules preserve independent blockers and before-BC source review',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE orders(carrier text,channel text,source_payload jsonb,erp_live jsonb,issue text,address jsonb,resolution_pending_resume boolean)');
  const source='TEMU · Données source différentes : articles/quantités · Rapprochement à vérifier',carrierReason='Transporteur non déterminé';
  for(const channel of ['temu','amazon','shopify'])for(const bc of [false,true])for(const known of [false,true])for(const stock of [false,true]){
   const issue=[source,carrierReason,...(stock?['Stock insuffisant']:[])].join(' ; ');
   await db.query('INSERT INTO orders VALUES($1,$2,$3,$4,$5,$6,false)',[known?'gofo':'unknown',channel,'{}',JSON.stringify(bc?{bc:{id:123}}:{}),issue,'{}']);
  }
  const before=(await db.query('SELECT * FROM orders')).rows;
  for(const row of (await db.query(`SELECT *,${currentReasonSql('issue')} AS projected,${currentReasonEmptySql('issue')} AS empty FROM orders`)).rows){
   const expected=[...(row.erp_live.bc?[]:[source]),...(row.carrier==='gofo'?[]:[carrierReason]),...(row.issue.includes('Stock insuffisant')?['Stock insuffisant']:[])].join(' ; ')||null;
   assert.equal(row.projected,expected);assert.equal(row.empty,expected===null);
  }
  assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);
 }finally{await db.close();}
});
