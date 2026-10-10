import {completedHistoricalPreparation,reconcileHistoricalPreparation,currentReplacementPreview,currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {refreshErplainDocuments} from './erplain-documents-sync.mjs';
import {readSku} from './problem-resolution.mjs';
import {bindProduct} from './product-bindings.mjs';

export const recheckCadence={local:5*60000,external:15*60000,alert:60*60000};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function monitoringObservation(order,previous={},now=Date.now()){
 const o=projectCurrentDiagnostics(structuredClone(order)),erp=o.erp_live||{};
 let reason=suspensionBlock(o)||o.issue||o.erp_live_job?.error||o.resolution_error||currentResolutionState(o.resolution_actions).reviews.map(j=>j.error).filter(Boolean).join(' ; ')||o.carrier_error||(o.resolution_pending_resume?'Reprise de préparation à vérifier':null)||(o.label_status==='blocked'||o.erp_status==='blocked'?'Préparation bloquée : vérification à reprendre':null);
 const preview=currentResolutionState(o.resolution_actions).pendingReplacement||currentReplacementPreview(o.latest_resolution);if(preview&&!suspensionBlock(o)&&(!reason||/Reprise historique|Reprise de préparation/.test(reason)))reason='Remplacement à confirmer';
 // Supplier reads and timestamps are deliberately absent: no artificial progress.
 const progress=hash([erp.bc?.id,erp.bl?.id,erp.bl?.status,erp.stockDocument?.id,erp.verifiedAt?true:false,o.suspension?.version,o.mapping_lines]);
 const lastProgress=previous.progress===progress&&Number.isFinite(Date.parse(previous.lastProgress))?previous.lastProgress:!previous.progress&&Number.isFinite(Date.parse(o.blocked_since))?new Date(o.blocked_since).toISOString():new Date(now).toISOString();
 const action=reason==='Remplacement à confirmer'?'Confirmer le remplacement ou reprendre explicitement le BC actuel':suspensionBlock(o)?'Attendre une décision explicite de réactivation dans V3':erp.mappingAlignmentAttempt?.status==='uncertain'?'Rapprocher le résultat de la modification du BC dans Erplain':/mapping/i.test(reason||'')?'Compléter le mapping applicable puis aligner le BC':/poids/i.test(reason||'')?'Vérifier le poids du produit puis reprendre la préparation':/SKU.*introuvable|produit.*absent/i.test(reason||'')?'Vérifier ou compléter la fiche produit Erplain du SKU concerné':/stock insuffisant/i.test(reason||'')?'Vérifier le stock disponible ou choisir un remplacement autorisé':/historique|BL non créé/i.test(reason||'')?'Rapprocher le BC et son débit existant, puis créer le BL manquant':/prix|TVA|totaux/i.test(reason||'')?'Corriger les montants source puis recontrôler le BC':reason?'Recontrôler les données et reprendre les étapes autorisées dès validation':'Aucune action attendue';
 const alert=!!reason&&now-Date.parse(lastProgress)>=recheckCadence.alert;
 return {...previous,lastCheck:new Date(now).toISOString(),nextCheck:new Date(now+recheckCadence.local).toISOString(),result:reason||'Aucun blocage constaté',nextStep:action,blocked:!!reason,followUp:!!reason||previous.followUp===true||previous.blocked===true,progress,lastProgress,alert,alertSince:alert?(previous.alertSince||new Date(now).toISOString()):null};
}
export async function initializeOrderRecheckMonitor(db,{afterPublication=false}={}){
 await db.exec(`CREATE TABLE IF NOT EXISTS order_recheck_monitor(order_id text PRIMARY KEY REFERENCES orders(id),state jsonb NOT NULL DEFAULT '{}',next_check timestamptz NOT NULL DEFAULT now(),next_external timestamptz NOT NULL DEFAULT now(),requested bigint NOT NULL DEFAULT 1,checked bigint NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS order_recheck_resources(resource text PRIMARY KEY,next_check timestamptz NOT NULL,result jsonb NOT NULL);
 CREATE INDEX IF NOT EXISTS order_recheck_due ON order_recheck_monitor(next_check);
 CREATE OR REPLACE FUNCTION v3_request_order_recheck() RETURNS trigger AS $$ DECLARE oid text; BEGIN
 IF TG_TABLE_NAME='orders' THEN oid=NEW.id; ELSE oid=NEW.order_id; END IF;
 IF oid IS NOT NULL THEN INSERT INTO order_recheck_monitor(order_id) VALUES(oid) ON CONFLICT(order_id) DO UPDATE SET next_check=now(),next_external=CASE WHEN TG_TABLE_NAME IN ('correction_jobs','lines') THEN now() ELSE order_recheck_monitor.next_external END,requested=order_recheck_monitor.requested+1; END IF;
 RETURN NEW; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS v3_recheck_order ON orders;
 CREATE TRIGGER v3_recheck_order AFTER INSERT OR UPDATE OF source_payload,issue,erp_live,resolution_pending_resume,suspension ON orders FOR EACH ROW EXECUTE FUNCTION v3_request_order_recheck();
 INSERT INTO order_recheck_monitor(order_id) SELECT id FROM orders ON CONFLICT DO NOTHING;`);
 for(const table of ['resolution_jobs','correction_jobs'])await db.exec(`DROP TRIGGER IF EXISTS v3_recheck_correction ON ${table};CREATE TRIGGER v3_recheck_correction AFTER INSERT OR UPDATE OF status,result,error ON ${table} FOR EACH ROW EXECUTE FUNCTION v3_request_order_recheck();`);
 await db.exec(`DROP TRIGGER IF EXISTS v3_recheck_line ON lines;CREATE TRIGGER v3_recheck_line AFTER INSERT OR UPDATE OF quantity,source_sku,target_sku,target_quantity,source_payload ON lines FOR EACH ROW EXECUTE FUNCTION v3_request_order_recheck();
 CREATE OR REPLACE FUNCTION v3_recheck_mapping() RETURNS trigger AS $$ BEGIN
 INSERT INTO order_recheck_monitor(order_id) SELECT DISTINCT o.id FROM orders o JOIN lines l ON l.order_id=o.id WHERE o.channel=NEW.channel AND l.source_sku=NEW.source_sku ON CONFLICT(order_id) DO UPDATE SET next_check=now(),next_external=now(),requested=order_recheck_monitor.requested+1;RETURN NEW;END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS v3_recheck_mapping ON mappings;CREATE TRIGGER v3_recheck_mapping AFTER INSERT OR UPDATE ON mappings FOR EACH ROW EXECUTE FUNCTION v3_recheck_mapping();`);
 if(afterPublication)await db.query('UPDATE order_recheck_monitor SET next_check=now(),next_external=now(),requested=requested+1');
}
export function orderRecheckMonitor(db,api,{enabled=()=>true,canResume=()=>true,now=()=>Date.now(),readDocuments=refreshErplainDocuments,readProduct=readSku,cacheProduct=bindProduct,maxSkuReads=50,maxDocReads=20}={}){
 let running=false,localRunning=false;
 async function runLocal(){
  if(localRunning||!enabled())return;localRunning=true;
  try{await db.withLocks(['order-recheck-local'],async()=>{
   const due=(await db.query(`SELECT o.*,m.state monitoring_previous,m.requested monitor_version,e.status erp_job_status,e.error erp_job_error,e.state_since blocked_since,c.error carrier_error,
    (SELECT jsonb_agg(to_jsonb(current_actions) ORDER BY created_at DESC,id DESC) FROM (SELECT DISTINCT ON(action) action,status,error,result,created_at,id FROM resolution_jobs WHERE order_id=o.id ORDER BY action,created_at DESC,id DESC) current_actions) resolution_actions,
    (SELECT CASE WHEN status='review' THEN error ELSE null END FROM resolution_jobs WHERE order_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1) resolution_error,
    (SELECT jsonb_agg(jsonb_build_object('source',l.source_sku,'sku',CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(p.target_sku,l.target_sku,l.source_sku) END,'quantity',CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_quantity WHEN p.source_qty>0 THEN round(l.quantity*p.target_qty/p.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END) ORDER BY l.id) FROM lines l LEFT JOIN mappings p ON p.channel=o.channel AND p.source_sku=l.source_sku WHERE l.order_id=o.id) mapping_lines
    FROM order_recheck_monitor m JOIN orders o ON o.id=m.order_id LEFT JOIN erp_live_jobs e ON e.order_id=o.id LEFT JOIN carrier_jobs c ON c.order_id=o.id WHERE m.next_check<=now() OR m.requested<>m.checked ORDER BY m.next_check LIMIT 2000`)).rows;
   for(const o of due)if(completedHistoricalPreparation(o,{status:o.erp_job_status,error:o.erp_job_error},now())){const result=await reconcileHistoricalPreparation(db,o.id);if(result.updated){o.label_status='production_ready';o.issue=null;}}
   const observations=due.map(o=>{o.erp_live_job={status:o.erp_job_status,error:o.erp_job_error};const state=monitoringObservation(o,o.monitoring_previous,now());return {id:o.id,state,next_check:state.nextCheck,version:o.monitor_version};});
   if(observations.length)await db.query('UPDATE order_recheck_monitor m SET state=x.state,next_check=x.next_check,checked=x.version FROM jsonb_to_recordset($1::jsonb) AS x(id text,state jsonb,next_check timestamptz,version bigint) WHERE m.order_id=x.id',[JSON.stringify(observations)]);
  });}finally{localRunning=false;}
 }
 async function runExternal(){
  if(running||!enabled())return;running=true;
  try{await db.withLocks(['order-recheck-external'],async()=>{
   const external=(await db.query(`SELECT o.*,m.state FROM order_recheck_monitor m JOIN orders o ON o.id=m.order_id WHERE m.next_external<=now() AND m.state->>'blocked'='true' AND NOT o.archived AND coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation') AND NOT EXISTS(SELECT 1 FROM erp_live_jobs WHERE order_id=o.id AND status IN ('pending','processing')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=o.id AND status IN ('queued','running','waiting')) ORDER BY m.next_external LIMIT 100`)).rows;
   if(!external.length)return;
   try{await api.verify?.();}catch(e){await db.query("UPDATE order_recheck_monitor SET next_external=now()+interval '15 minutes',next_check=now(),requested=requested+1,state=state||$2::jsonb WHERE order_id=ANY($1::text[])",[external.map(o=>o.id),JSON.stringify({lastExternalCheck:new Date(now()).toISOString(),externalResult:e.message})]);return;}
   // Share each exact SKU read across this batch; two calls at most in flight.
   const skus=[...new Set(external.flatMap(o=>(o.state?.mapping_lines||[]).map(l=>l.sku)))];
   const lines=(await db.query(`SELECT DISTINCT l.order_id,CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,l.source_sku) END sku FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=ANY($1::text[])`,[external.map(o=>o.id)])).rows;
   skus.push(...lines.map(l=>l.sku).filter(Boolean));
   const unique=[...new Set(skus)],errors=new Map(),covered=new Set();let cursor=0,skuReads=0,docReads=0;
   const read=async()=>{while(cursor<unique.length&&enabled()){const sku=unique[cursor++];const cached=(await db.query('SELECT result FROM order_recheck_resources WHERE resource=$1 AND next_check>now()',['sku:'+sku])).rows[0];if(cached){covered.add(sku);if(cached.result?.error)errors.set(sku,cached.result.error);continue;}if(skuReads>=maxSkuReads)continue;skuReads++;try{const r=await readProduct(api,sku);if(r.usable)await cacheProduct(db,r.variant);await db.query("INSERT INTO order_recheck_resources(resource,next_check,result) VALUES($1,now()+interval '15 minutes',$2) ON CONFLICT(resource) DO UPDATE SET next_check=excluded.next_check,result=excluded.result",['sku:'+sku,JSON.stringify({status:r.status,readAt:new Date(now()).toISOString()})]);}catch(e){errors.set(sku,e.message);await db.query("INSERT INTO order_recheck_resources(resource,next_check,result) VALUES($1,now()+interval '15 minutes',$2) ON CONFLICT(resource) DO UPDATE SET next_check=excluded.next_check,result=excluded.result",['sku:'+sku,JSON.stringify({error:e.message})]);}covered.add(sku);}};
   await Promise.all([read(),read()]);
   for(const o of external){if(!enabled())break;let result={notRequested:true};
    const orderSkus=lines.filter(l=>l.order_id===o.id).map(l=>l.sku).filter(Boolean),needsDocuments=!!o.erp_live?.bc?.id||/historique|document|\bBC\b|\bBL\b|annul/i.test(o.state?.result||'');
    if(orderSkus.some(sku=>!covered.has(sku))||needsDocuments&&docReads>=maxDocReads){await db.query("UPDATE order_recheck_monitor SET next_external=now()+interval '1 minute',next_check=now(),requested=requested+1,state=state||$2::jsonb WHERE order_id=$1",[o.id,JSON.stringify({externalResult:'Controles cibles partiels : suite planifiee au prochain passage'})]);continue;}
    if(needsDocuments){docReads++;try{result=await readDocuments(db,api,o.id);}catch(e){result={error:e.message};}}

    await db.query("UPDATE order_recheck_monitor SET next_external=now()+interval '15 minutes',next_check=now(),requested=requested+1,state=state||$2::jsonb WHERE order_id=$1",[o.id,JSON.stringify({lastExternalCheck:new Date(now()).toISOString(),externalResult:result?.error|| (orderSkus.some(sku=>errors.has(sku))?'Certaines lectures produit restent à vérifier':'Lectures ciblées terminées')})]);
    const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
    if(canResume()&&fresh&&!suspensionBlock(fresh)&&!fresh.partial_mode&&!fresh.archived&&['historical_review','bc_created'].includes(fresh.erp_live?.phase)&&fresh.erp_live?.bc?.id&&!fresh.erp_live.bl?.id&&!fresh.erp_live.stockCreationAttemptedAt&&!fresh.erp_live.stockDocument?.id&&fresh.erp_live.pricing?.status==='verified'&&!fresh.source_payload?.erplainValidationHold&&!fresh.source_payload?.visibilityHold&&!fresh.source_payload?.marketplacePendingCorrection&&!result?.error){
     const id=randomUUID(),requestId='historical-recheck-'+hash([fresh.id,fresh.erp_live.bc.id,new Date(now()).toISOString().slice(0,16)]);
     await db.transaction(async tx=>{const locked=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[fresh.id])).rows[0];if(!enabled()||!canResume()||!locked||String(locked.erp_live?.bc?.id)!==String(fresh.erp_live.bc.id)||locked.erp_live?.stockCreationAttemptedAt||locked.erp_live?.stockDocument?.id||locked.erp_live?.pricing?.status!=='verified'||suspensionBlock(locked)||locked.archived||locked.partial_mode||locked.erp_live?.bl?.id||!['historical_review','bc_created'].includes(locked.erp_live?.phase)||locked.source_payload?.erplainValidationHold||locked.source_payload?.visibilityHold||locked.source_payload?.marketplacePendingCorrection)return;const actions=(await tx.query(resolutionStateSql,[fresh.id])).rows;if(currentResolutionState(actions).pendingReplacement)return;const queued=await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,result) SELECT $1,$2,$3,'resume-erp',$4,$5 WHERE NOT EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=$2 AND status IN ('queued','running','waiting')) ON CONFLICT DO NOTHING RETURNING id",[id,fresh.id,requestId,JSON.stringify({id:fresh.id,requestId,action:'resume-erp',type:'stock',resumeAfter:true}),JSON.stringify({erpOnly:true,existingLabelsPreserved:true,automaticRecheck:true})]);if(queued.rows.length)await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:order-recheck','resolution.requested',$1)",[JSON.stringify({id,orderId:fresh.id,action:'resume-erp',automaticRecheck:true,existingLabelsPreserved:true})]);});
    }
   }
  });}finally{running=false;}
 }
 return {get running(){return running||localRunning;},runLocal,runExternal,async run(){await runLocal();await runExternal();}};
}
