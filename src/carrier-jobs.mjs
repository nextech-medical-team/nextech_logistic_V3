import {installCarrierQuotaColumns,deferCarrierQuota} from './carrier-erplain-quota.mjs';
import {retiredLabelPreparationReview} from './post-bl-preparation-review.mjs';
import {installCarrierAttemptProof,markCarrierCreationStarted,recordCarrierFailure} from './carrier-attempt-proof.mjs';
import {hasCreatedBl} from './created-bl-label.mjs';
import {usesRecordedBc,recordedBcFingerprint} from './existing-bc-execution.mjs';
function assertRecordedPreparationUnchanged(o){
 if(hasCreatedBl(o))return;
 const authority=o.erp_live?.preparationAuthority;
 // A changed global mapping or an absent legacy fingerprint never vetoes a label.
 // When a recorded BC proof exists, keep the newer protection against changing
 // that very document after preparation and before carrier creation.
 if(!usesRecordedBc(o)||authority?.kind!=='recorded_bc')return;
 let same=false;try{same=String(authority.bcId)===String(o.erp_live.bc.id)&&authority.fingerprint===recordedBcFingerprint(o.erp_live.bc);}catch{}
 if(!same)throw Error('BC modifié depuis sa préparation : recontrôle requis');
}
import {randomUUID} from 'node:crypto';
import {currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {assertTemuManualLabel} from './manual-label-policy.mjs';
import {assertBlLabelWorker} from './direct-label.mjs';
import {applyTenderBlLabelPayload} from './tender-bl-label-payload.mjs';
import {assertDirectCarrierAllowed} from './temu-label-policy.mjs';
import {assertPreparedLabelOrder} from './equivalent-auto-label.mjs';
import {initializePriority,carrierEligible,priorityOrder} from './order-priority.mjs';
import {assertLabelStockGate,validatedDeliverySql} from './label-stock-gate.mjs';
import {loadRouting} from './routing.mjs';
import {createTestCarriers,createProductionCarriers,pdfBytes} from './carriers-test.mjs';
export async function initializeCarrierJobs(db){await initializePriority(db);
 await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_live JSONB NOT NULL DEFAULT '{}'; CREATE TABLE IF NOT EXISTS carrier_jobs(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,carrier TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reference TEXT,tracking JSONB NOT NULL DEFAULT '[]',result JSONB,attempts INT NOT NULL DEFAULT 0,error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS carrier_documents(order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,document_index INT NOT NULL,pdf BYTEA NOT NULL,PRIMARY KEY(order_id,document_index));
 CREATE INDEX IF NOT EXISTS carrier_jobs_queue ON carrier_jobs(carrier,status,updated_at);`);
 await db.exec("ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS manual_bl_request JSONB;");
 await db.exec("ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS stock_override JSONB; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS creation_id TEXT; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS batch_id TEXT; CREATE TABLE IF NOT EXISTS carrier_label_history(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,job JSONB NOT NULL,archived_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS carrier_label_history_documents(history_id TEXT REFERENCES carrier_label_history(id) ON DELETE CASCADE,document_index INT NOT NULL,pdf BYTEA NOT NULL,PRIMARY KEY(history_id,document_index));");
 await installCarrierAttemptProof(db);
 await installCarrierQuotaColumns(db);
 // A process interruption after POST is ambiguous. Never resend that POST blindly.
 if(db.recoverInterrupted!==false)await db.query(`UPDATE carrier_jobs SET status='review',error='Traitement interrompu. Vérifier la création chez le transporteur avant toute nouvelle tentative.' WHERE status='creating'`);
}
export async function queueCarrierLabels(db,ids,{automatic=false}={}){
 if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'))throw new Error('Sélectionner de 1 à 100 commandes');
 const transact=db.transaction?fn=>db.transaction(fn):fn=>fn(db);
 return transact(async tx=>{
  let queued=0;
  for(const id of [...new Set(ids)].sort()){
   const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!o||!['pending','simulated'].includes(o.label_status)||o.channel==='temu')continue;
   if((await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing','queued','running','waiting')",[id])).rows.length)throw Error('Préparation en cours : attendre sa validation');
   if((await tx.query('SELECT order_id FROM carrier_jobs WHERE order_id=$1',[id])).rows.length)continue;
   const corrections=(await tx.query("SELECT to_jsonb(c) correction FROM correction_jobs c WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting','review')",[id])).rows;
   if(corrections.some(({correction:c})=>!hasCreatedBl(o)||!['review','waiting'].includes(c.status)||!retiredLabelPreparationReview(c.error)))throw Error('Correction en cours ou à vérifier avant étiquette');
   const actions=(await tx.query(resolutionStateSql,[id])).rows,state=currentResolutionState(actions);
   if(!hasCreatedBl(o)&&(state.reviews.length||state.pendingReplacement||actions[0]?.result?.readOnly||actions[0]?.result?.resumeAfter===false))throw Error('Décision de préparation à vérifier avant étiquette');
   if(o.source_payload?.visibilityHold||o.source_payload?.historicalShipments?.length||o.source_payload?.externalLabel?.active)throw Error('Expédition ou suspension existante à rapprocher');
   const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[id])).rows[0];
   assertPreparedLabelOrder(o,e);
   if(!hasCreatedBl(o)&&!o.erp_live.bc?.id)throw Error('Identité du BC non vérifiée');
   if(!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier))throw Error('Transporteur non déterminé');
   if(o.resolution_pending_resume&&!hasCreatedBl(o)){
    const r=actions[0];
    if(r?.status!=='complete'||r.error||r.result?.partialRemainder||!(r.result?.erpOnly||r.result?.equivalent))throw Error('Préparation suspendue : terminer sa validation');
   }
   await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[id]);
   // The recorded BC owns this preparation; later global mappings cannot veto its label.
   assertRecordedPreparationUnchanged(o);
   await assertLabelStockGate(tx,o);
   if((await tx.query('SELECT document_index FROM carrier_documents WHERE order_id=$1 LIMIT 1',[id])).rows.length)throw Error('Étiquette existante à rapprocher');
   if((await tx.query('SELECT id FROM carrier_label_history WHERE order_id=$1 LIMIT 1',[id])).rows.length)throw Error('Historique transporteur à rapprocher');
   if((await tx.query("SELECT 1 FROM extra_parcels WHERE order_id=$1 LIMIT 1",[id])).rows.length||(await tx.query("SELECT 1 FROM partial_deliveries WHERE order_id=$1 LIMIT 1",[id])).rows.length)throw Error('Colis existant à rapprocher avant étiquette');
   const added=await tx.query("INSERT INTO carrier_jobs(order_id,carrier,environment,creation_id,batch_id) VALUES($1,$2,'production',$3,$4) ON CONFLICT DO NOTHING RETURNING order_id",[id,o.carrier.startsWith('gls')?'gls':'gofo',randomUUID(),automatic?'automatic-bl-ready':null]);
   if(added.rows.length){
    await tx.query("UPDATE orders SET resolution_pending_resume=false,label_status='production_pending' WHERE id=$1",[id]);
    await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','carrier.admitted',$1)",[JSON.stringify({orderId:id,automatic,existingBl:o.erp_live.bl.id})]);
    await tx.query("UPDATE order_recheck_monitor SET next_check=now(),requested=requested+1,state=state||$2::jsonb WHERE order_id=$1",[id,JSON.stringify({carrierAdmission:{status:'queued',checkedAt:new Date().toISOString()}})]);
    queued++;
   }
  }
  return queued;
 });
}

export function createCarrierWorkers(db,config,{clients,productionConfig}={}){
 const client=config?createTestCarriers(config):null,active=new Set();
 const productionClient=productionConfig?createProductionCarriers(productionConfig):(clients||null);
 async function run(carrier){
  if(active.has(carrier))return;active.add(carrier);
  try{
   const job=await db.transaction(async tx=>{
    const {rows}=await tx.query(`SELECT * FROM carrier_jobs WHERE carrier=$1 AND ${carrierEligible} ORDER BY ${priorityOrder('carrier_jobs')} FOR UPDATE SKIP LOCKED LIMIT 1`,[carrier]);
    if(!rows.length)return null;await tx.query(`UPDATE carrier_jobs SET status=$2,attempts=attempts+1,updated_at=now() WHERE order_id=$1`,[rows[0].order_id,rows[0].status==='pending'?'creating':'awaiting_pdf']);return rows[0];
   });if(!job)return;
   let result=job.result,creationStarted=!!job.creation_started_at;
   try{
    const selectedClient=job.environment==='production'?productionClient:client;
    if(!selectedClient)throw new Error('Accès transporteur production non configurés');
    let o=(await db.query('SELECT * FROM orders WHERE id=$1',[job.order_id])).rows[0];
    o.glsInternational={...(await loadRouting(db)).international,...o.source_payload?.glsInternationalOverride};
    o.lines=(await db.query('SELECT source_sku,target_sku,quantity,target_quantity FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
    if(!result){
     if(creationStarted){const error=Error('Création transporteur déjà engagée : rapprocher son résultat');error.uncertain=true;throw error;}
     assertDirectCarrierAllowed(o,carrier);
     if(o.channel==='temu')assertTemuManualLabel((await db.query('SELECT status FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0]);
     if(job.environment!=='production')throw new Error('Création TEST désactivée : reprendre la commande en production');
     const directBl=!!job.manual_bl_request?.creationId&&job.manual_bl_request.creationId===job.creation_id;
     if(directBl){assertBlLabelWorker(o,job.manual_bl_request);o=applyTenderBlLabelPayload(o,job.manual_bl_request);}
     else{
      const e=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[o.id])).rows[0];
      if(!job.stock_override){
       assertPreparedLabelOrder(o,e);
       assertRecordedPreparationUnchanged(o);
      }
      await assertLabelStockGate(db,o,job.stock_override);
     }
     if((await db.query('SELECT 1 FROM carrier_documents WHERE order_id=$1 LIMIT 1',[o.id])).rows.length)throw Error('PDF existant à rapprocher : aucune nouvelle création');
     if(carrier==='gls'&&o.carrier==='gls_shop'){
      const shop=await selectedClient.resolveParcelShop(o);
      o.source_payload={...o.source_payload,glsParcelShopId:shop.parcelShopId,glsParcelShop:shop};
      await db.transaction(async tx=>{
       await tx.query("UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1",[o.id,JSON.stringify({glsParcelShopId:shop.parcelShopId,glsParcelShop:shop,...(o.source_payload.shopifyRelay?{shopifyRelay:o.source_payload.shopifyRelay}:{})})]);
       await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','gls.parcelshop_resolved',$1)",[JSON.stringify({orderId:o.id,parcelShopId:shop.parcelShopId,selection:shop.selection,environment:job.environment})]);
      });
     }
     // No database transaction is held during a network call.
     if(job.environment==='production')o.duplicate_of=o.id;
     const shipment={...o,id:job.creation_id||o.id};
     const beforeCreate=async()=>{if(!creationStarted){await markCarrierCreationStarted(db,o.id);creationStarted=true;}};
     result=carrier==='gls'?await selectedClient.gls(shipment,{beforeCreate,onParcel:async partial=>{await db.query("UPDATE carrier_jobs SET result=$2,tracking=$3,updated_at=now() WHERE order_id=$1",[o.id,JSON.stringify(partial),JSON.stringify(partial.tracking)]);}}):await selectedClient.gofoCreate(shipment,{beforeCreate});
     await db.query(`UPDATE carrier_jobs SET result=$2,reference=$3,tracking=$4,status='awaiting_pdf',updated_at=now() WHERE order_id=$1`,[o.id,JSON.stringify(result),result.reference,JSON.stringify(result.tracking)]);
    }
    const documents=carrier==='gofo'?[await selectedClient.gofoLabel(result.reference)]:result.documents;
    if(!documents?.length)throw new Error('Expédition créée mais PDF non fourni. Création conservée, aucun nouvel envoi.');
    if(!result.tracking.length)throw new Error('Numéro de suivi non fourni ; création conservée pour vérification.');
    const buffers=documents.map(pdfBytes);
    await db.transaction(async tx=>{
     for(let i=0;i<buffers.length;i++)await tx.query(`INSERT INTO carrier_documents VALUES($1,$2,$3) ON CONFLICT(order_id,document_index) DO NOTHING`,[o.id,i,buffers[i]]);
     await tx.query(`UPDATE carrier_jobs SET status='ready',error=null,result=null,updated_at=now() WHERE order_id=$1`,[o.id]);
     await tx.query(`UPDATE orders SET label_status=CASE WHEN resolution_pending_resume AND NOT $3 THEN label_status ELSE $2 END,issue=CASE WHEN resolution_pending_resume THEN issue ELSE null END,processing_priority_at=null WHERE id=$1`,[o.id,job.environment==='production'?'production_ready':'sandbox_ready',!!job.manual_bl_request&&job.manual_bl_request.creationId===job.creation_id]);
    });
    }catch(e){
    if(!creationStarted&&!result&&!e.uncertain&&await deferCarrierQuota(db,job,e))return;
    if(carrier==='gofo'&&!result&&e.zoneRejected){
     await db.transaction(async tx=>{
      await tx.query("UPDATE orders SET carrier='gls',parcel_count=ceil(weight_kg/30),source_payload=source_payload||$2::jsonb WHERE id=$1",[job.order_id,JSON.stringify({gofoZoneRefusal:{reason:e.message,at:new Date().toISOString(),fallback:'gls'}})]);
      await tx.query("UPDATE carrier_jobs SET carrier='gls',status='pending',attempts=0,error=$2,failure_phase=null,creation_started_at=null,updated_at=now() WHERE order_id=$1",[job.order_id,'Bascule GLS après refus explicite de zone GOFO : '+e.message]);
      await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','carrier.gofo_zone_fallback',$1)",[JSON.stringify({orderId:job.order_id,reason:e.message})]);
     });return;
    }
    const status=result?(carrier==='gofo'&&job.attempts+1<5?'awaiting_pdf':'review'):(e.uncertain?'review':'failed');
    await recordCarrierFailure(db,job.order_id,{status,error:e.message,creationStarted:creationStarted||e.uncertain===true,hasResult:!!result});
   }
  }finally{active.delete(carrier);}
 }
 return {run,active};
}

