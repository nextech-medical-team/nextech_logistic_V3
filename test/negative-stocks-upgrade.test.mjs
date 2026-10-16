import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeAppSchema} from '../src/schema-startup.mjs';
import {negativeStocksHistory} from '../src/negative-stocks.mjs';

test('existing installations gain stock history without replaying startup recovery or initializers',async()=>{
 const db=new PGlite();db.withLocks=async(keys,fn)=>fn();
 try{
  await db.exec('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY); CREATE TABLE protected_jobs(id TEXT PRIMARY KEY,status TEXT); INSERT INTO protected_jobs VALUES(\'shipment\',\'creating\');');
  for(const version of ['application-20261005-robustness-5','partial-temu-label-20261016-1','carrier-manual-bl-request-20261013-1','carrier-attempt-proof-20261014-1','partial-erplain-retry-20261016-1'])await db.query('INSERT INTO schema_migrations VALUES($1)',[version]);
  const forbidden=()=>{throw Error('Existing initializer must not replay');};
  await initializeAppSchema(db,[forbidden]);
  const history=negativeStocksHistory(db,{page:async()=>({page:1,lastPage:1,locationId:'7',checkedAt:new Date().toISOString(),rows:[],unverified:0})});
  const result=await history.scan({}, {email:'fixture@example.invalid'});
  assert.equal(result.saved,true);
  await initializeAppSchema(db,[forbidden]);
  assert.equal((await history.list()).rows.length,1);
  assert.equal((await db.query('SELECT status FROM protected_jobs')).rows[0].status,'creating');
  assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='negative-stock-history-20261016-1'")).rows[0].n,1);
 }finally{await db.close();}
});
