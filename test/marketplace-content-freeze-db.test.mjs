import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {retirePostBcSourceReviews,marketplaceContentFrozenSql,sourceReviewReasonSql,retireSourceReviewReason} from '../src/marketplace-content-freeze.mjs';
test('SQL cleanup and displayed mixed diagnostics preserve all independent blockers and documents',async()=>{
 const e=new PGlite();const db={query:(...a)=>e.query(...a),transaction:fn=>e.transaction(tx=>fn(tx))};try{
 await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,erp_live jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',issue text,label_status text DEFAULT 'blocked',resolution_pending_resume boolean DEFAULT true,suspension jsonb DEFAULT '{"active":true}');CREATE TABLE documents(order_id text,pdf bytea);`);
 const reason='TEMU · Données source différentes : articles/quantités · Rapprochement à vérifier ; Stock insuffisant';
 for(const channel of ['temu','amazon','shopify'])await e.query('INSERT INTO orders(id,channel,erp_live,source_payload,issue) VALUES($1,$1,$2,$3,$4)',[channel,JSON.stringify({bc:{id:123},bl:{id:456}}),JSON.stringify({marketplacePendingCorrection:{lines:[{sku:'changed',quantity:999}]},platformModificationFields:{fields:['articles/quantités']},savedContent:{sku:'saved',quantity:10}}),reason]);
 await e.query('INSERT INTO orders(id,channel,issue) VALUES($1,$2,$3)',['initial','temu',reason]);await e.exec("INSERT INTO documents VALUES('temu',decode('0102ff','hex'))");
 const before=await e.query('SELECT * FROM documents');const rows=(await e.query(`SELECT *,${sourceReviewReasonSql('issue')} AS projected,${marketplaceContentFrozenSql()} AS frozen FROM orders`)).rows;
 for(const o of rows)assert.equal(o.projected,retireSourceReviewReason(o,o.issue));
 assert.equal((await retirePostBcSourceReviews(db)).checked,3);assert.equal((await retirePostBcSourceReviews(db)).checked,0);
 for(const o of (await e.query('SELECT * FROM orders WHERE id<>\'initial\'')).rows){assert.equal(o.issue,'Stock insuffisant');assert.equal(o.label_status,'blocked');assert.equal(o.resolution_pending_resume,true);assert.deepEqual(o.suspension,{active:true});assert.deepEqual(o.source_payload.savedContent,{sku:'saved',quantity:10});assert.deepEqual(o.erp_live,{bc:{id:123},bl:{id:456}});}
 assert.deepEqual(await e.query('SELECT * FROM documents'),before);assert.equal((await e.query('SELECT issue FROM orders WHERE id=\'initial\'')).rows[0].issue,reason);
 }finally{await e.close();}
});
