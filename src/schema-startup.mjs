import {installCarrierAttemptProof} from './carrier-attempt-proof.mjs';
import {installCarrierQuotaColumns,recoverLegacyCarrierQuota} from './carrier-erplain-quota.mjs';
import {initializeOperations} from './runtime.mjs';
import {installEventTriggers} from './live-events.mjs';
import {initializeNegativeStocks} from './negative-stocks.mjs';
const version='application-20261005-robustness-5';
const carrierBlRequestVersion='carrier-manual-bl-request-20261013-1';
export async function initializeAppSchema(db,initializers,{background=false}={}){
 await db.withLocks(['schema'],async()=>{
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',[version])).rows.length){
   await db.transaction(async tx=>{tx.recoverInterrupted=false;await initializeOperations(tx);for(const initialize of initializers)await initialize(tx);await installEventTriggers(tx);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);});
  }
  // Existing installations keep the application marker when new initializers
  // gain columns. Apply this additive migration without replaying initializers
  // or changing any queued/creating shipment or external-operation state.
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['partial-extra-parcels-20261028-1'])).rows.length){
   await db.transaction(async tx=>{
    if(!(await tx.query("SELECT to_regclass('extra_parcels') AS table_name")).rows[0]?.table_name)return;
    await tx.exec('ALTER TABLE extra_parcels ADD COLUMN IF NOT EXISTS delivery_id TEXT; CREATE INDEX IF NOT EXISTS extra_parcels_delivery_idx ON extra_parcels(delivery_id)');
    await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['partial-extra-parcels-20261028-1']);
   });
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',[carrierBlRequestVersion])).rows.length){
   await db.transaction(async tx=>{
    await tx.exec('ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS manual_bl_request JSONB');
    await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[carrierBlRequestVersion]);
   });
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['carrier-attempt-proof-20261014-1'])).rows.length){
   await db.transaction(async tx=>{await installCarrierAttemptProof(tx);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['carrier-attempt-proof-20261014-1']);});
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['carrier-erplain-quota-20261021-1'])).rows.length){
   await db.transaction(async tx=>{await installCarrierQuotaColumns(tx);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['carrier-erplain-quota-20261021-1']);});
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['partial-erplain-retry-20261016-1'])).rows.length){
   await db.transaction(async tx=>{await tx.exec('ALTER TABLE partial_deliveries ADD COLUMN IF NOT EXISTS erplain_retry JSONB');await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['partial-erplain-retry-20261016-1']);});
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['partial-temu-label-20261016-1'])).rows.length){
   await db.transaction(async tx=>{await tx.exec('ALTER TABLE partial_deliveries ADD COLUMN IF NOT EXISTS temu_label JSONB');await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['partial-temu-label-20261016-1']);});
  }
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=$1',['negative-stock-history-20261016-1'])).rows.length){
   await db.transaction(async tx=>{await initializeNegativeStocks(tx);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',['negative-stock-history-20261016-1']);});
  }
 });
 if(background){await recoverInterruptedJobs(db);await recoverLegacyCarrierQuota(db);}
}
export async function recoverInterruptedJobs(db){
 // The worker leader owns recovery. Read-only work may resume; external writes
 // require reconciliation because a remote operation may already have succeeded.
 await db.transaction(async tx=>{
  for(const [table,statuses,next,error] of [
   ['carrier_jobs',['creating'],'review','Traitement interrompu : vérifier la création transporteur'],
   ['extra_parcels',['creating'],'review','Création interrompue : vérifier le colis transporteur'],
   ['erp_live_jobs',['processing'],'review','Traitement interrompu : rapprocher les documents Erplain'],
   ['partial_deliveries',['creating_bl','selecting_lines','publishing_bl','creating_stock','creating_label'],'review','Livraison interrompue : vérifier les documents et le colis'],
   ['correction_jobs',['applying'],'review','Correction interrompue : relire les données Erplain'],
   ['resolution_jobs',['running'],'review','Intervention interrompue : vérifier les dernières écritures'],
   ['purchase_jobs',['creating'],'review','Création interrompue : vérifier Erplain LIVE'],
   ['temu_label_jobs',['purchasing'],'uncertain','Achat interrompu : récupérer son résultat avant toute nouvelle tentative'],
   ['erplain_refresh_jobs',['running'],'interrupted','Synchronisation interrompue : les données reçues sont conservées']
  ])await tx.query(`UPDATE ${table} SET status=$2,error=$3 WHERE status=ANY($1::text[])`,[statuses,next,error]);
  await tx.query("UPDATE read_service_jobs SET status='queued' WHERE status='running'");
  await tx.query("UPDATE marketplace_receipts SET status='pending',error=null WHERE status='processing'");
  await tx.query("UPDATE label_export_jobs SET status='pending' WHERE status='running'");
 });
}
