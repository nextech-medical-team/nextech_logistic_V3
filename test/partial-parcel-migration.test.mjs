import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {initializeAppSchema} from '../src/schema-startup.mjs';
test('existing installation receives parcel BL column without replaying initializers or changing queued work',async()=>{
 const e=new PGlite();await e.waitReady;const wrap=x=>({query:(s,p=[])=>x.query(s,p),exec:s=>x.exec(s)}),db={...wrap(e),withLocks:async(_,fn)=>fn(),transaction:fn=>e.transaction(tx=>fn(wrap(tx)))};
 try{await e.exec("CREATE TABLE schema_migrations(version text PRIMARY KEY);CREATE TABLE extra_parcels(id text,status text);INSERT INTO extra_parcels VALUES('existing','creating');");
 for(const version of ['application-20261005-robustness-5','carrier-manual-bl-request-20261013-1','carrier-attempt-proof-20261014-1','carrier-erplain-quota-20261021-1','partial-erplain-retry-20261016-1','partial-temu-label-20261016-1','negative-stock-history-20261016-1'])await db.query('INSERT INTO schema_migrations VALUES($1)',[version]);
 for(let i=0;i<2;i++)await initializeAppSchema(db,[()=>{throw Error('Existing initializers must not replay');}]);
 assert.deepEqual((await db.query('SELECT id,status,delivery_id FROM extra_parcels')).rows,[{id:'existing',status:'creating',delivery_id:null}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE version='partial-extra-parcels-20261028-1'")).rows[0].n,1);
 }finally{await e.close();}
});
