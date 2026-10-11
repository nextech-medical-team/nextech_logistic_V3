import {assertTemuManualLabel} from './manual-label-policy.mjs';
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
 await db.exec("ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test';");
 await db.exec("ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS stock_override JSONB; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS creation_id TEXT; ALTER TABLE carrier_jobs ADD COLUMN IF NOT EXISTS batch_id TEXT; CREATE TABLE IF NOT EXISTS carrier_label_history(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,job JSONB NOT NULL,archived_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS carrier_label_history_documents(history_id TEXT REFERENCES carrier_label_history(id) ON DELETE CASCADE,document_index INT NOT NULL,pdf BYTEA NOT NULL,PRIMARY KEY(history_id,document_index));");
 // A process interruption after POST is ambiguous. Never resend that POST blindly.
 if(db.recoverInterrupted!==false)await db.query(`UPDATE carrier_jobs SET status='review',error='Traitement interrompu. Vérifier la création chez le transporteur avant toute nouvelle tentative.' WHERE status='creating'`);
}
export async function queueCarrierLabels(db,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'))throw new Error('Sélectionner de 1 à 100 commandes');
 return db.transaction(async tx=>{
  let queued=0;
  for(const id of [...new Set(ids)].sort()){
   const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!o||!['pending','simulated'].includes(o.label_status)||o.channel==='temu')continue;
   if((await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[id])).rows.length)continue;
   if((await tx.query('SELECT order_id FROM carrier_jobs WHERE order_id=$1',[id])).rows.length)continue;
   const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[id])).rows[0];
   assertPreparedLabelOrder(o,e);
   if(!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier))throw Error('Transporteur non déterminé');
   if(o.resolution_pending_resume){
    const r=(await tx.query('SELECT status,result FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0];
    if(r?.status!=='complete'||!(r.result?.erpOnly||r.result?.equivalent))throw Error('Préparation suspendue : terminer sa validation');
   }
   await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[id]);
   await assertLabelStockGate(tx,o);
   if((await tx.query('SELECT document_index FROM carrier_documents WHERE order_id=$1 LIMIT 1',[id])).rows.length)throw Error('Étiquette existante à rapprocher');
   if((await tx.query('SELECT id FROM carrier_label_history WHERE order_id=$1 LIMIT 1',[id])).rows.length)throw Error('Historique transporteur à rapprocher');
   const added=await tx.query("INSERT INTO carrier_jobs(order_id,carrier,environment) VALUES($1,$2,'production') ON CONFLICT DO NOTHING RETURNING order_id",[id,o.carrier.startsWith('gls')?'gls':'gofo']);
   if(added.rows.length){
    await tx.query("UPDATE orders SET resolution_pending_resume=false,label_status='production_pending' WHERE id=$1",[id]);
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
   let result=job.result;
   try{
    const selectedClient=job.environment==='production'?productionClient:client;
    if(!selectedClient)throw new Error('Accès transporteur production non configurés');
    const o=(await db.query('SELECT * FROM orders WHERE id=$1',[job.order_id])).rows[0];
    o.glsInternational={...(await loadRouting(db)).international,...o.source_payload?.glsInternationalOverride};
    o.lines=(await db.query('SELECT source_sku,target_sku,quantity,target_quantity FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
    if(!result){
     assertDirectCarrierAllowed(o,carrier);
     if(o.channel==='temu')assertTemuManualLabel((await db.query('SELECT status FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0]);
     if(job.environment!=='production')throw new Error('Création TEST désactivée : reprendre la commande en production');
     await assertLabelStockGate(db,o,job.stock_override);
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
     result=carrier==='gls'?await selectedClient.gls(shipment,{onParcel:async partial=>{await db.query("UPDATE carrier_jobs SET result=$2,tracking=$3,updated_at=now() WHERE order_id=$1",[o.id,JSON.stringify(partial),JSON.stringify(partial.tracking)]);}}):await selectedClient.gofoCreate(shipment);
     await db.query(`UPDATE carrier_jobs SET result=$2,reference=$3,tracking=$4,status='awaiting_pdf',updated_at=now() WHERE order_id=$1`,[o.id,JSON.stringify(result),result.reference,JSON.stringify(result.tracking)]);
    }
    const documents=carrier==='gofo'?[await selectedClient.gofoLabel(result.reference)]:result.documents;
    if(!documents?.length)throw new Error('Expédition créée mais PDF non fourni. Création conservée, aucun nouvel envoi.');
    if(!result.tracking.length)throw new Error('Numéro de suivi non fourni ; création conservée pour vérification.');
    const buffers=documents.map(pdfBytes);
    await db.transaction(async tx=>{
     for(let i=0;i<buffers.length;i++)await tx.query(`INSERT INTO carrier_documents VALUES($1,$2,$3) ON CONFLICT(order_id,document_index) DO UPDATE SET pdf=excluded.pdf`,[o.id,i,buffers[i]]);
     await tx.query(`UPDATE carrier_jobs SET status='ready',error=null,result=null,updated_at=now() WHERE order_id=$1`,[o.id]);
     await tx.query(`UPDATE orders SET label_status=CASE WHEN resolution_pending_resume THEN label_status ELSE $2 END,issue=CASE WHEN resolution_pending_resume THEN issue ELSE null END,processing_priority_at=null WHERE id=$1`,[o.id,job.environment==='production'?'production_ready':'sandbox_ready']);
    });
    }catch(e){
    if(carrier==='gofo'&&!result&&e.zoneRejected){
     await db.transaction(async tx=>{
      await tx.query("UPDATE orders SET carrier='gls',parcel_count=ceil(weight_kg/30),source_payload=source_payload||$2::jsonb WHERE id=$1",[job.order_id,JSON.stringify({gofoZoneRefusal:{reason:e.message,at:new Date().toISOString(),fallback:'gls'}})]);
      await tx.query("UPDATE carrier_jobs SET carrier='gls',status='pending',attempts=0,error=$2,updated_at=now() WHERE order_id=$1",[job.order_id,'Bascule GLS après refus explicite de zone GOFO : '+e.message]);
      await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','carrier.gofo_zone_fallback',$1)",[JSON.stringify({orderId:job.order_id,reason:e.message})]);
     });return;
    }
    const status=result?(carrier==='gofo'&&job.attempts+1<5?'awaiting_pdf':'review'):(e.uncertain?'review':'failed');
    await db.query(`UPDATE carrier_jobs SET status=$2,error=$3,updated_at=now() WHERE order_id=$1`,[job.order_id,status,e.message]);
   }
  }finally{active.delete(carrier);}
 }
 return {run,active};
}

