import {shopifyCancellationWorker} from './shopify-cancellation-worker.mjs';
import {readyWeightAllowed,validateReadyPreparation} from './ready-preparation.mjs';
import {aggregateParcels} from './status-policy.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {erplainLifecycleGateway} from './erplain-lifecycle-gateway.mjs';
import {documentLifecycle} from './document-lifecycle.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {initializeTracking,trackingTargets,currentTracking} from './carrier-tracking.mjs';
export async function initializeLifecycle(db){
 await initializeTracking(db);
 await db.exec(`CREATE TABLE IF NOT EXISTS document_lifecycle(bl_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),partial_id TEXT,journal JSONB NOT NULL DEFAULT '{}',result JSONB,error TEXT,locked BOOLEAN NOT NULL DEFAULT false,checked_at TIMESTAMPTZ,requested BOOLEAN NOT NULL DEFAULT true);`);
 await db.exec(`ALTER TABLE document_lifecycle ADD COLUMN IF NOT EXISTS preparation_revision TEXT;`);
 // An interrupted lock stays visible for reconciliation instead of replaying a mutation.
}
export function lifecycleWorker(db,directory,{gateway=erplainLifecycleGateway(erplainAccount(directory,'live')),stockGate=assertLabelStockGate,cancellations=shopifyCancellationWorker(db,directory)}={}){
 let running=false;
 const store={
  read:async id=>(await db.query('SELECT journal FROM document_lifecycle WHERE bl_id=$1',[id])).rows[0].journal,
  save:async(id,journal)=>db.query('UPDATE document_lifecycle SET journal=$2 WHERE bl_id=$1',[id,JSON.stringify(journal)]),
  async withLock(id,fn){const claimed=await db.query('UPDATE document_lifecycle SET locked=true WHERE bl_id=$1 AND locked=false RETURNING bl_id',[id]);if(!claimed.rows.length)throw Error('Traitement dÃ©jÃ  en cours ou interrompu : rapprochement requis');try{return await fn();}finally{await db.query('UPDATE document_lifecycle SET locked=false WHERE bl_id=$1',[id]);}}
 };
 const engine=documentLifecycle({gateway,store,onStatus:async(bl,input)=>{
   const link=(await db.query('SELECT order_id,partial_id FROM document_lifecycle WHERE bl_id=$1',[String(input.blId)])).rows[0];
   if(link.partial_id)await db.query("UPDATE partial_deliveries SET bl=bl||$2::jsonb WHERE id=$1",[link.partial_id,JSON.stringify({status:bl.status})]);
   else await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}',to_jsonb($2::text)) WHERE id=$1",[link.order_id,bl.status]);
   await db.query("UPDATE document_lifecycle SET result=coalesce(result,'{}'::jsonb)||jsonb_build_object('bl',$2::jsonb) WHERE bl_id=$1",[String(input.blId),JSON.stringify(bl)]);
  }});
 async function discover(){
  await db.query(`INSERT INTO document_lifecycle(bl_id,order_id) SELECT erp_live->'bl'->>'id',id FROM orders WHERE archived=false AND (simulation=false OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=orders.id AND c.environment='production' AND c.status='ready')) AND partial_mode=false AND erp_live->'bl'->>'id' ~ '^[0-9]+$' ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO document_lifecycle(bl_id,order_id,partial_id) SELECT p.bl->>'id',o.id,p.id FROM partial_deliveries p JOIN orders o ON o.id=p.order_id WHERE o.archived=false AND o.partial_mode=true AND p.bl->>'id' ~ '^[0-9]+$' ON CONFLICT DO NOTHING`);
 }
 return {
  async list(){await discover();return (await db.query('SELECT l.bl_id,l.order_id,o.reference,l.partial_id,l.result,l.error,l.locked,l.checked_at,l.requested FROM document_lifecycle l JOIN orders o ON o.id=l.order_id ORDER BY l.error NULLS LAST,l.checked_at DESC NULLS LAST LIMIT 500')).rows;},
  async request(){await discover();await db.query('UPDATE document_lifecycle SET requested=true WHERE locked=false');return {message:'ContrÃ´le des BL, factures et paiements Erplain LIVE demandÃ©.'};},
  async run(){if(running)return;running=true;try{
   await cancellations.run();
   await discover();
   const row=(await db.query(lifecycleCandidateSql)).rows[0];if(!row)return;
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[row.order_id])).rows[0];
   let input={blId:row.bl_id,bcId:o.erp_live?.bc?.id,channel:o.channel,expectedTracking:[],events:[],preparationComplete:false};
   try{
    if(row.partial_id){const d=(await db.query('SELECT * FROM partial_deliveries WHERE id=$1',[row.partial_id])).rows[0];input.expectedTracking=d.tracking||[];input.preparationComplete=d.status==='ready'&&readyWeightAllowed(o.channel,d.weight_kg)&&!!d.stock_document&&!!d.selection?.length;}
    else{
     const c=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
     input.expectedTracking=c?.tracking||[];
     const extra=(await db.query("SELECT tracking,status FROM extra_parcels WHERE order_id=$1 AND status NOT IN ('failed','cancelled')",[o.id])).rows;
     input.expectedTracking.push(...extra.map(p=>p.tracking||'missing:'+o.id));
     let labelReady=c?.status==='ready'&&extra.every(p=>p.status==='ready');
     if(o.channel==='temu'){
      const t=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];
      if(t){input.expectedTracking=(t.result?.packageInfoResultList||[]).map(p=>p.trackingNumber||'missing:'+p.packageSn);input.events=(t.result?.deliveryStatuses||[]).filter(e=>e.source==='temu_tracking').map(e=>({tracking:e.trackingKey,carrier:'temu',code:e.code,label:e.label,at:e.at}));labelReady=t.status==='complete';
       input.cancellationConfirmed=t.status==='cancelled'&&t.result?.source==='v2_readonly'&&t.result?.v2State==='cancelled';
      }
     }
     if(labelReady&&readyWeightAllowed(o.channel,o.weight_kg)){try{input.preparationComplete=await validateReadyPreparation(db,o,stockGate);}catch(e){input.preparationWarning=e.message;}}
    }
    if(o.channel!=='temu'||row.partial_id){
     const targets=await trackingTargets(db,o.id,row.partial_id);
     if(targets.some(t=>t.carrier)){
      const snapshot=await currentTracking(db,targets);input.expectedTracking=targets.map(t=>t.tracking);input.events=snapshot.events;input.trackingWarnings=snapshot.errors;
     }
    }
    if(o.channel==='temu'&&!row.partial_id){
     const aggregate=aggregateParcels(input.expectedTracking,input.events);
     if(aggregate.status!=='unknown')await db.query("UPDATE orders SET tracking_status=$2 WHERE id=$1 AND tracking_status<>'delivered' AND NOT (tracking_status IN ('shipped','in_transit') AND $2='not_shipped')",[o.id,aggregate.status]);
    }
    // No guessed shipping state: only structured carrier events or Erplain's own status.
    const result=await engine.resume(input);
    result.trackingWarnings=input.trackingWarnings||[];
    result.preparationWarning=input.preparationWarning||null;
    await db.query('UPDATE document_lifecycle SET result=$2,error=null,checked_at=now(),requested=false,preparation_revision=$3 WHERE bl_id=$1',[row.bl_id,JSON.stringify(result),row.current_revision]);
    if(row.partial_id)await db.query("UPDATE partial_deliveries SET bl=bl||$2::jsonb WHERE id=$1",[row.partial_id,JSON.stringify({status:result.bl.status})]);
    else await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}',to_jsonb($2::text)) WHERE id=$1",[o.id,result.bl.status]);
    if(result.billing==='paid'&&!row.partial_id)await db.query("UPDATE orders SET invoice_status='paid' WHERE id=$1",[o.id]);
   }catch(e){await db.query('UPDATE document_lifecycle SET error=$2,checked_at=now(),requested=false,preparation_revision=$3 WHERE bl_id=$1',[row.bl_id,e.message,row.current_revision]);}
  }finally{running=false;}},
  get running(){return running;}
 };
}

// Watch preparation evidence, not our own BL status/result writes. A completed
// correction, label or partial delivery wakes the lifecycle on its next tick.
export const lifecycleCandidateSql=`WITH candidates AS (
 SELECT l.*,row_to_json(o) AS order_data,
 EXISTS(SELECT 1 FROM temu_label_jobs t WHERE t.reference=o.reference AND jsonb_array_length(coalesce(t.result->'deliveryStatuses','[]'::jsonb))>0) AS physical_hint,
 (CASE WHEN l.partial_id IS NOT NULL THEN EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.id=l.partial_id AND p.status='ready')
 ELSE (o.channel='temu' OR o.weight_kg>0) AND (o.channel='temu' OR o.resolution_pending_resume=false) AND o.erp_live->>'verifiedAt' IS NOT NULL AND o.erp_live->>'stockCheckedAt' IS NOT NULL
 AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='complete')
 AND (EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status='ready') OR EXISTS(SELECT 1 FROM temu_label_jobs t WHERE t.reference=o.reference AND t.status='complete')) END) AS ready_hint,
 md5(jsonb_build_array('tracking-v4-temu-ready-without-weight',
  o.weight_kg,o.address,o.resolution_pending_resume,o.source_payload->'marketplacePendingCorrection',
  o.erp_live->'bc'->'id',o.erp_live->'bl'->'id',o.erp_live->'verifiedAt',o.erp_live->'stockCheckedAt',
  o.erp_live->'stockDocument',o.erp_live->'labelPreparationFingerprint',
  (SELECT status FROM erp_live_jobs WHERE order_id=o.id),
  (SELECT jsonb_agg(jsonb_build_array(source_line,source_sku,target_sku,quantity,target_quantity) ORDER BY source_line,id) FROM lines WHERE order_id=o.id),
  (SELECT jsonb_build_array(status,environment,tracking) FROM carrier_jobs WHERE order_id=o.id),
  (SELECT jsonb_build_array(status,result->'packageInfoResultList',result->'deliveryStatuses',result->'trackingErrors') FROM temu_label_jobs WHERE reference=o.reference),
  (SELECT jsonb_agg(jsonb_build_array(status,tracking) ORDER BY id) FROM extra_parcels WHERE order_id=o.id),
  (SELECT jsonb_build_array(status,weight_kg,stock_document,selection,tracking) FROM partial_deliveries WHERE id=l.partial_id)
 )::text) AS current_revision
 FROM document_lifecycle l JOIN orders o ON o.id=l.order_id
 WHERE coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation') AND l.locked=false AND o.archived=false AND
 ((o.partial_mode=false AND l.partial_id IS NULL AND (o.simulation=false OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.environment='production' AND c.status='ready')))
 OR (o.partial_mode=true AND l.partial_id IS NOT NULL))
)
SELECT * FROM candidates WHERE requested=true
 OR preparation_revision IS DISTINCT FROM current_revision
 OR (error IS NULL AND checked_at<now()-interval '6 hours')
ORDER BY physical_hint DESC,ready_hint DESC NULLS LAST,(preparation_revision IS DISTINCT FROM current_revision) DESC,checked_at NULLS FIRST LIMIT 1`;

