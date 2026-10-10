import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTrackingTargets,trackingSyncStore} from '../src/tracking-sync-store.mjs';
import {createTrackingTestDb} from './support/tracking-db.mjs';

test('SQL : cibles de production, BL partiels, verrou et rapprochement local',async()=>{
 const db=await createTrackingTestDb();
 try{
  const targets=await loadTrackingTargets(db);
  assert.equal(targets.length,3);
  assert.deepEqual(targets[0].tracking,['TRACK1','TRACK2']);
  assert.equal(targets[0].carrier,'gls');
  assert.equal(targets[1].partialId,'p1');
  assert.equal(targets[2].carrier,'temu');
  const store=trackingSyncStore(db);
  await store.assertCarrierAvailable('gls');
  await store.deferCarrier('gls',7200);
  await assert.rejects(store.assertCarrierAvailable('gls'),/suspendue/);
  await store.assertCarrierAvailable('gofo');
  await store.assertCurrent(targets[0]);
  await store.withLock(targets[0],async()=>{
   await assert.rejects(store.withLock(targets[0],async()=>{}),/déjà en traitement/);
   await store.record('tracking_sync.intent',{blId:'20'});
   await store.confirm(targets[0],'delivered');
  });
  assert.equal((await db.query('SELECT locked FROM document_lifecycle')).rows[0].locked,false);
  const order=(await db.query("SELECT * FROM orders WHERE id='o1'")).rows[0];
  assert.equal(order.tracking_status,'delivered');assert.equal(order.erp_live.bl.status,'delivered');
  await store.confirm(targets[1],'delivered');
  assert.equal((await db.query("SELECT tracking_status FROM orders WHERE id='o2'")).rows[0].tracking_status,null);
  assert.equal((await db.query("SELECT bl FROM partial_deliveries WHERE id='p1'")).rows[0].bl.status,'delivered');
  await db.exec("UPDATE orders SET suspension='{\"active\":true}' WHERE id='o1'");
  await assert.rejects(store.assertCurrent(targets[0]),/modifiés/);
  await db.exec("UPDATE settings SET value='{\"lifecycle\":true}'");
  await assert.rejects(store.withLock(targets[1],async()=>{}),/réactivé/);
 }finally{await db.close();}
});
