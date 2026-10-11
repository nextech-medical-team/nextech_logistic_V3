import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {withoutPreparationObservation,withoutPreparationObservationSql,obsoletePreparationObservations,preparationObservation,currentMovementDetail} from '../src/movement-watch-diagnostic.mjs';
import {movementWatchdog} from '../src/movement-watch.mjs';
test('transport information cannot assert a historical hold or a suspension',()=>{
 assert.equal(currentMovementDetail('preparation_only_observed','stale'),preparationObservation);
 assert.ok(!preparationObservation.includes('Suspension'));assert.ok(!preparationObservation.includes('Reprise historique'));
 assert.equal(currentMovementDetail('read_incomplete','Quota partagé'),'Quota partagé');
});
test('remove only identified observations, preserving independent business errors',()=>{
 for(const old of obsoletePreparationObservations){assert.equal(withoutPreparationObservation(old),null);assert.equal(withoutPreparationObservation('Stock insuffisant ; '+old+' ; TVA différente'),'Stock insuffisant; TVA différente');}
 for(const real of ['TVA source · Lignes ou emplacements ambigus','Commande suspendue','Reprise historique à vérifier : BL non créé','Suivi du colis non vérifiable (TEMU) : Quota partagé'])assert.equal(withoutPreparationObservation(real),real);
});
test('SQL and JS agree, watchdog repairs stored diagnostics without provider reads or business changes',async()=>{
 const pg=new PGlite();await pg.waitReady;try{
 await pg.exec(`CREATE TABLE orders(id text PRIMARY KEY,issue text,bc jsonb,stock int,suspension jsonb,channel text DEFAULT 'temu');CREATE TABLE erp_live_jobs(order_id text,status text,error text);CREATE TABLE settings(key text PRIMARY KEY,value jsonb);CREATE TABLE movement_watch(order_id text,reason_code text,detail text,lease_until timestamptz,state text,next_check_at timestamptz,lease_token text,updated_at timestamptz,first_observed_at timestamptz,source_fingerprint text,alert_key text,alerted_at timestamptz);`);
 const old=obsoletePreparationObservations[1];for(const value of [null,old,'Prix incohérent ; '+old,preparationObservation,'Stock insuffisant'])assert.equal((await pg.query('SELECT '+withoutPreparationObservationSql('$1::text')+' value',[value])).rows[0].value,withoutPreparationObservation(value));
 await pg.query("INSERT INTO orders(id,issue,bc,stock,suspension) VALUES('1',$1,'{\"id\":7}',20,'{\"active\":true}')",[old]);await pg.query("INSERT INTO erp_live_jobs VALUES('1','review',$1)",[old]);await pg.query("INSERT INTO movement_watch(order_id,reason_code,detail,first_observed_at) VALUES('1','preparation_only_observed',$1,now())",[old]);
 const before=(await pg.query('SELECT bc,stock,suspension FROM orders')).rows;
 const db={query:(q,p)=>q.startsWith('INSERT INTO movement_watch(order_id,first_observed_at)')?Promise.resolve({rows:[]}):pg.query(q,p)};
 await movementWatchdog(db);await movementWatchdog(db);
 assert.equal((await pg.query('SELECT issue FROM orders')).rows[0].issue,null);assert.deepEqual((await pg.query('SELECT bc,stock,suspension FROM orders')).rows,before);
 assert.deepEqual((await pg.query('SELECT status,error FROM erp_live_jobs')).rows[0],{status:'review',error:null});assert.equal((await pg.query('SELECT detail FROM movement_watch')).rows[0].detail,preparationObservation);
 }finally{await pg.close();}
});
