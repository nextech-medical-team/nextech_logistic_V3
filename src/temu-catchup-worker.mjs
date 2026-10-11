import {randomUUID,createHash} from 'node:crypto';
import {withShipmentLock} from './shipment-lock.mjs';
import {temuCatchupCadence,temuCatchupDelay,temuSourceError,partialTemuReadProof,pureTemuSourceReadError} from './temu-catchup-policy.mjs';
import {reconcileTemuCatchup,observeTemuSourceStage} from './temu-catchup-reconcile.mjs';
const fingerprint=o=>createHash('sha256').update(JSON.stringify([o.reference,o.source_reference,o.source_payload,o.address,o.recipient,o.erp_live,o.suspension,o.partial_mode,o.archived,o.issue,o.label_status,o.erp_status,o.tracking_status,o.resolution_pending_resume])).digest('hex');
export async function initializeTemuCatchup(db){await db.exec(`CREATE TABLE IF NOT EXISTS temu_source_catchup(
 order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 failures INTEGER NOT NULL DEFAULT 0,first_failure_at TIMESTAMPTZ,last_attempt_at TIMESTAMPTZ,last_success_at TIMESTAMPTZ,
 lease_token TEXT,lease_until TIMESTAMPTZ,observation JSONB,error JSONB,review JSONB,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS temu_source_catchup_due ON temu_source_catchup(next_at);
 CREATE OR REPLACE FUNCTION temu_catchup_register_changed() RETURNS trigger LANGUAGE plpgsql AS $register$
 DECLARE target_id text; row_data jsonb:=to_jsonb(NEW);
 BEGIN
  IF TG_TABLE_NAME='orders' THEN target_id:=row_data->>'id';
  ELSIF TG_TABLE_NAME='temu_label_jobs' THEN SELECT id INTO target_id FROM orders WHERE channel='temu' AND reference=row_data->>'reference';
  ELSE target_id:=row_data->>'order_id'; END IF;
  IF target_id IS NULL OR EXISTS(SELECT 1 FROM temu_source_catchup WHERE order_id=target_id) THEN RETURN NEW; END IF;
  INSERT INTO temu_source_catchup(order_id) SELECT o.id FROM orders o WHERE o.id=target_id AND (${temuBlockedSql}) ON CONFLICT DO NOTHING;
  RETURN NEW;
 END $register$;
 DO $triggers$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['orders','order_recheck_monitor','erp_live_jobs','carrier_jobs','temu_label_jobs','resolution_jobs'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='temu_catchup_register_'||table_name AND tgrelid=to_regclass(table_name)) THEN
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION temu_catchup_register_changed()','temu_catchup_register_'||table_name,table_name);
   END IF;
  END LOOP;
 END $triggers$;
 INSERT INTO temu_source_catchup(order_id) SELECT o.id FROM orders o WHERE ${temuBlockedSql} ON CONFLICT DO NOTHING;`);}
export const temuBlockedSql=`o.channel='temu' AND NOT o.archived AND o.duplicate_of IS NULL AND (
 coalesce(o.issue,'')<>'' OR o.resolution_pending_resume OR o.label_status='blocked' OR o.erp_status IN ('blocked','live_review')
 OR o.source_payload ? 'temuReceiptObservation' OR o.source_payload->'sourceCoverage'->>'complete'='false' OR o.source_payload->>'visibilityHold'='true' OR o.source_payload ? 'marketplacePendingCorrection'
 OR o.source_payload->'temuDirect'->>'state'='error' OR o.source_payload->'temuAmountsError' IS NOT NULL AND o.source_payload->'temuAmountsError'<>'null'::jsonb
 OR EXISTS(SELECT 1 FROM order_recheck_monitor m WHERE m.order_id=o.id AND m.state->>'blocked'='true')
 OR EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND (e.status IN ('review','failed') OR e.error IS NOT NULL))
 OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND (c.status IN ('review','failed') OR c.error IS NOT NULL))
 OR EXISTS(SELECT 1 FROM temu_label_jobs j WHERE j.reference=o.reference AND (j.error IS NOT NULL OR j.status IN ('api_error','uncertain')))
 OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status='review' AND r.error IS NOT NULL))`;
export function temuCatchupWorker(db,loadSources,{shouldStop=()=>false,now=()=>Date.now(),withLock=withShipmentLock,reconcile=reconcileTemuCatchup}={}){
 let running=false,initialized=false,lastScan=null,sources=[],sourcesAt=0;
 return {get running(){return running;},async run(){
  if(running||shouldStop())return {skipped:true};running=true;let claim=null;
  try{
   const rows=(await db.query("SELECT key,value FROM settings WHERE key IN ('marketplace_automatic','background_tasks')")).rows,settings=Object.fromEntries(rows.map(r=>[r.key,r.value]));
   if(!settings.marketplace_automatic?.enabled||settings.marketplace_automatic.channels?.temu===false||settings.marketplace_automatic.temuCatchup?.enabled===false||settings.background_tasks?.['marketplace-temu']===false||settings.background_tasks?.['marketplace-collection']===false)return {skipped:true,reason:'disabled'};
   if(!initialized){await initializeTemuCatchup(db);initialized=true;}
   if(lastScan===null||now()-lastScan>=temuCatchupCadence.scan){await db.query(`INSERT INTO temu_source_catchup(order_id) SELECT o.id FROM orders o WHERE ${temuBlockedSql} ON CONFLICT DO NOTHING`);lastScan=now();}
   const token=randomUUID();claim=(await db.query(`WITH due AS(SELECT q.order_id FROM temu_source_catchup q JOIN orders o ON o.id=q.order_id WHERE q.next_at<=now() AND (q.lease_until IS NULL OR q.lease_until<=now()) AND (${temuBlockedSql}) ORDER BY q.last_attempt_at NULLS FIRST,CASE WHEN o.source_payload ? 'temuReceiptObservation' OR o.source_payload->>'visibilityHold'='true' THEN 0 ELSE 1 END,q.next_at,q.order_id FOR UPDATE OF q SKIP LOCKED LIMIT 1),claimed AS(UPDATE temu_source_catchup q SET lease_token=$1,lease_until=now()+interval '5 minutes',last_attempt_at=now() FROM due WHERE q.order_id=due.order_id RETURNING q.*) SELECT c.*,to_jsonb(o) AS "order" FROM claimed c JOIN orders o ON o.id=c.order_id`,[token])).rows[0];
   if(!claim)return {idle:true};
   const order=claim.order,mall=String(order.source_payload?.sourceShop||order.source_payload?.mallId||'');
   if(!sources.length||now()-sourcesAt>300000){sources=(await loadSources()).filter(s=>s.channel==='temu');sourcesAt=now();}
   const matches=sources.filter(s=>s.shop===mall);if(!mall||matches.length!==1||typeof matches[0].refreshSource!=='function')throw Object.assign(Error('TEMU · Boutique source indisponible pour le rattrapage'),{code:'TEMU_SHOP_UNAVAILABLE',field:'shop'});
   const known=(await db.query('SELECT packages FROM temu_label_jobs WHERE reference=$1',[order.reference])).rows[0]?.packages||[];
   const onProgress=async()=>{if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});const r=await db.query("UPDATE temu_source_catchup SET lease_until=now()+interval '5 minutes' WHERE order_id=$1 AND lease_token=$2 AND lease_until>now() RETURNING order_id",[order.id,token]);if(!r.rows.length)throw Object.assign(Error('TEMU · Réservation perdue'),{code:'TEMU_LEASE_LOST'});};
   const observation=await matches[0].refreshSource(order.source_reference||order.reference,{shouldStop,onProgress,knownPackages:known});
   if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});
   return await withLock(()=>db.transaction(async tx=>{
    const lease=(await tx.query('SELECT * FROM temu_source_catchup WHERE order_id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',[order.id,token])).rows[0];if(!lease)return {skipped:true,reason:'lease-lost'};
    const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(!fresh||fingerprint(fresh)!==fingerprint(order))throw Object.assign(Error('TEMU · Commande locale modifiée pendant la lecture'),{code:'TEMU_LOCAL_CHANGED',field:'local'});
    const review=observation.coreComplete?await reconcile(tx,fresh,observation):observation.requiredComplete?await observeTemuSourceStage(tx,fresh,observation):null;
    if(!observation.coreComplete&&!observation.requiredComplete){
     const partial=partialTemuReadProof(fresh,observation);
     if(partial){const source={...fresh.source_payload,temuCatchupPartial:partial};const issue=pureTemuSourceReadError(fresh.issue)||fresh.source_payload?.temuCatchupPartial?.currentReason&&fresh.issue===fresh.source_payload.temuCatchupPartial.currentReason?partial.currentReason:fresh.issue;
      await tx.query('UPDATE orders SET source_payload=$2::jsonb,issue=$3 WHERE id=$1',[fresh.id,JSON.stringify(source),issue]);}
    }
    const expectedStage=observation.requiredComplete&&!observation.coreComplete;
    const failures=observation.complete||expectedStage?0:claim.failures+1,delay=expectedStage?(observation.sourceStage==='pending'?120000:3600000):failures?temuCatchupDelay(failures,Math.max(0,...observation.errors.map(e=>e.retryAfterMs||0))):temuCatchupCadence.normal;
    await tx.query(`UPDATE temu_source_catchup SET observation=$3::jsonb,review=$4::jsonb,error=$5::jsonb,failures=$6,first_failure_at=CASE WHEN $8 THEN coalesce(first_failure_at,now()) WHEN $6=0 THEN null ELSE coalesce(first_failure_at,now()) END,last_success_at=CASE WHEN $9 THEN now() ELSE last_success_at END,next_at=now()+($7::double precision*interval '1 millisecond'),lease_token=null,lease_until=null,updated_at=now() WHERE order_id=$1 AND lease_token=$2`,[order.id,token,JSON.stringify(observation),JSON.stringify(review),JSON.stringify(observation.errors),failures,delay,expectedStage&&observation.sourceStage==='pending',observation.complete]);
    const firstFailure=lease.first_failure_at?Date.parse(lease.first_failure_at):now(),elapsed=failures||expectedStage&&observation.sourceStage==='pending'?Math.max(0,now()-firstFailure):0;
    await tx.query("UPDATE order_recheck_monitor SET next_check=now(),requested=requested+1,state=state||jsonb_build_object('temuSourceCatchup',jsonb_build_object('checkedAt',$2::text,'complete',$3::boolean,'errors',$4::jsonb,'nextCheck',now()+($5::double precision*interval '1 millisecond'),'alert',$6::boolean,'escalated',$7::boolean)) WHERE order_id=$1",[order.id,observation.checkedAt,observation.complete,JSON.stringify(observation.errors),delay,elapsed>=temuCatchupCadence.alert,elapsed>=temuCatchupCadence.escalate]);
    return {orderId:order.id,complete:observation.complete,review,delay};
   }));
  }catch(error){
   if(!claim)throw error;
   if(shouldStop()||['TEMU_STOPPING','TEMU_LEASE_LOST'].includes(error.code)){await db.query('UPDATE temu_source_catchup SET lease_token=null,lease_until=null WHERE order_id=$1 AND lease_token=$2',[claim.order_id,claim.lease_token]);return {skipped:true,reason:error.code};}
   const failure=temuSourceError(error,error.field||'connection');
   if(error.code==='source_budget_deferred'){
    const delay=Math.max(1000,failure.retryAfterMs);
    await db.query("UPDATE temu_source_catchup SET next_at=now()+($3::double precision*interval '1 millisecond'),lease_token=null,lease_until=null WHERE order_id=$1 AND lease_token=$2",[claim.order_id,claim.lease_token,delay]);
    return {orderId:claim.order_id,deferred:true,delay};
   }
   const delay=temuCatchupDelay(claim.failures+1,failure.retryAfterMs);
   await db.query("UPDATE temu_source_catchup SET failures=failures+1,first_failure_at=coalesce(first_failure_at,now()),error=$3::jsonb,next_at=now()+($4::double precision*interval '1 millisecond'),lease_token=null,lease_until=null,updated_at=now() WHERE order_id=$1 AND lease_token=$2",[claim.order_id,claim.lease_token,JSON.stringify([failure]),delay]);
   await db.query("UPDATE order_recheck_monitor m SET next_check=now(),requested=requested+1,state=state||jsonb_build_object('temuSourceCatchup',jsonb_build_object('checkedAt',now(),'complete',false,'errors',$2::jsonb,'nextCheck',q.next_at,'alert',q.first_failure_at<=now()-interval '1 hour','escalated',q.first_failure_at<=now()-interval '4 hours')) FROM temu_source_catchup q WHERE q.order_id=$1 AND m.order_id=q.order_id",[claim.order_id,JSON.stringify([failure])]);
   return {orderId:claim.order_id,failed:true,error:failure,delay};
  }finally{running=false;}
 }};
}
