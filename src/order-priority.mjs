import {bcAllowedSql} from './bc-authorization.mjs';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
// Shared by the claim queries and the queue-position display.
export const erplainEligible = `status='pending' AND EXISTS(SELECT 1 FROM orders o WHERE o.id=erp_live_jobs.order_id AND (${bcAllowedSql}) AND (o.erp_live->'bc'->>'id' IS NULL OR NOT o.resolution_pending_resume)) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=erp_live_jobs.order_id AND r.status IN ('queued','running'))`;
export const carrierEligible = `NOT EXISTS(SELECT 1 FROM orders suspended_order WHERE suspended_order.id=carrier_jobs.order_id AND (coalesce(suspended_order.suspension->>'active','false')='true' OR suspended_order.suspension ? 'erplainCancellation')) AND ((status='pending' AND ((manual_bl_request->>'creationId'=creation_id) OR stock_override IS NOT NULL OR NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=carrier_jobs.order_id AND o.resolution_pending_resume=true))) OR (status='awaiting_pdf' AND attempts<5 AND updated_at<now()-interval '10 seconds'))`;
export const priorityOrder = table => `(SELECT processing_priority_at FROM orders WHERE id=${table}.order_id) ASC NULLS LAST,${table}.updated_at,${table}.order_id`;

export async function initializePriority(db){
 await db.exec('ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_priority_at TIMESTAMPTZ');
}

export async function initializeProcessingClock(db){
 // Old rows deliberately have no start time: their updated_at can be a poll.
 await db.exec(`CREATE OR REPLACE FUNCTION v3_processing_clock() RETURNS trigger AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.state_since=now();
 ELSIF NEW.status IS DISTINCT FROM OLD.status OR (NEW.status IN ('review','failed','uncertain','shipment_error','api_error','document_unavailable','cancellation_requested') AND NEW.error IS DISTINCT FROM OLD.error) THEN NEW.state_since=now();
 END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;`);
 for(const table of ['erp_live_jobs','carrier_jobs','resolution_jobs','temu_label_jobs']){
  await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS state_since TIMESTAMPTZ;
   DROP TRIGGER IF EXISTS v3_processing_clock ON ${table};
   CREATE TRIGGER v3_processing_clock BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION v3_processing_clock();`);
 }
}

export async function setOrderPriority(db,{id,enabled},user){
 if(!['admin','manager','operator'].includes(user?.role))throw Error('Action non autorisée');
 if(typeof id!=='string'||typeof enabled!=='boolean')throw Error('Commande et priorité requises');
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT id,archived,processing_priority_at FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!o||o.archived)throw Error('Commande absente ou archivée');
  const state=(await processingRows(tx,[id]))[0];
  if(enabled&&!state?.canPrioritize)throw Error('Cette commande est déjà expédiée ou son étiquette est disponible. Actualisez son état.');
  await tx.query('UPDATE orders SET processing_priority_at=CASE WHEN $2 THEN coalesce(processing_priority_at,now()) ELSE null END WHERE id=$1',[id,enabled]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'order.priority',$2)",[user.email,JSON.stringify({orderId:id,enabled})]);
  return {ok:true,enabled};
 });
}

export async function processingRows(db,ids){
 if(!Array.isArray(ids)||ids.length>200||ids.some(id=>typeof id!=='string'))throw Error('Sélection invalide');
 if(!ids.length)return [];
 const {rows}=await db.query(`WITH eq AS (
 SELECT order_id,row_number() OVER(ORDER BY ${priorityOrder('erp_live_jobs')})::int position,count(*) OVER()::int total FROM erp_live_jobs WHERE ${erplainEligible}
 ),ea AS (SELECT count(*)::int total FROM erp_live_jobs WHERE status='processing'),cq AS (
 SELECT order_id,row_number() OVER(PARTITION BY carrier ORDER BY ${priorityOrder('carrier_jobs')})::int position FROM carrier_jobs WHERE ${carrierEligible}
 ),rq AS (
 SELECT order_id,row_number() OVER(ORDER BY ${priorityOrder('resolution_jobs')})::int position FROM resolution_jobs WHERE status='queued'
 ) SELECT o.id,to_jsonb(o) diagnostic_order,o.source_payload->'externalLabel' external_label,o.transport_choice,o.processing_priority_at,o.tracking_status,o.label_status,o.suspension,o.erp_live->>'phase' phase,
 e.status erp_status,e.error erp_error,e.state_since erp_since,e.updated_at erp_updated,eq.position erp_position,coalesce(eq.total,(SELECT max(total) FROM eq),0) erp_total,(SELECT total FROM ea) erp_active,
 c.status carrier_status,c.carrier,c.error carrier_error,c.state_since carrier_since,c.updated_at carrier_updated,cq.position carrier_position,to_jsonb(c)||jsonb_build_object('documentCount',CASE WHEN c.status='failed' THEN (SELECT count(*) FROM carrier_documents d WHERE d.order_id=o.id) ELSE 0 END) diagnostic_carrier,
 r.status resolution_status,r.action resolution_action,r.result resolution_result,r.stage,r.error resolution_error,r.state_since resolution_since,r.updated_at resolution_updated,rq.position resolution_position,to_jsonb(r) diagnostic_resolution,
 t.status temu_status,t.error temu_error,t.state_since temu_since,t.updated_at temu_updated,
 ts.status temu_sync_status,ts.started_at temu_sync_since,ts.updated_at temu_sync_updated,
 EXISTS(SELECT 1 FROM lines l WHERE l.order_id=o.id AND l.target_sku=r.result->>'originalSku') preview_original_present
 FROM orders o LEFT JOIN erp_live_jobs e ON e.order_id=o.id LEFT JOIN carrier_jobs c ON c.order_id=o.id
 LEFT JOIN temu_label_jobs t ON t.reference=o.reference AND o.channel='temu'
 LEFT JOIN temu_sync_jobs ts ON ts.reference=o.reference AND o.channel='temu'
 LEFT JOIN LATERAL(SELECT * FROM resolution_jobs WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1) r ON true
 LEFT JOIN eq ON eq.order_id=o.id LEFT JOIN cq ON cq.order_id=o.id LEFT JOIN rq ON rq.order_id=o.id
 WHERE o.id=ANY($1::text[]) AND o.archived=false`,[ids]);
 return rows.map(row=>{
  const current=projectCurrentDiagnostics({...row.diagnostic_order,
   erp_live_job:{error:row.erp_error,updated_at:row.erp_updated},
   carrier_job:row.diagnostic_carrier||{error:row.carrier_error,updated_at:row.carrier_updated},
   resolution_active:row.diagnostic_resolution?{...row.diagnostic_resolution,carrier:row.diagnostic_resolution.payload?.carrier}:null,
   temu_job:row.temu_status?{status:row.temu_status,error:row.temu_error,state_since:row.temu_since,updated_at:row.temu_updated}:null,
   resolution_error:row.resolution_error,resolution_error_updated_at:row.resolution_updated});
  return {...processingView({...row,erp_error:current.erp_live_job.error,carrier_error:current.carrier_job.error,
   resolution_error:current.resolution_error,temu_error:current.previous_temu_label_refusal?null:row.temu_error,manual_label_request:current.manual_label_request,label_manual_request_required:current.label_manual_request_required}),currentCarrier:row.diagnostic_order?.carrier||null,
   label_manual_request_required:!!current.label_manual_request_required,label_diagnostic_history:current.label_diagnostic_history||[],manual_label_request:current.manual_label_request||null,previous_temu_label_refusal:current.previous_temu_label_refusal||null};
 });
}

const serviceName = value => ({gls:'GLS home',gls_pharma:'GLS PHARMA',gls_shop:'GLS Shop',gofo:'GOFO',temu:'TEMU'})[value]||String(value||'Transporteur').toUpperCase();
export function processingView(r){
 const base={id:r.id,priority:!!r.processing_priority_at,canPrioritize:!['shipped','in_transit','delivered'].includes(r.tracking_status)&&!['production_ready','sandbox_ready','ready'].includes(r.label_status),position:null,since:null,stage:null,remaining:null};
 const activities=[];
 const add=(service,state,step,since,lastSignal,reason,extra={})=>activities.push({service,state,step,since:since||null,lastSignal:lastSignal||null,reason:reason||null,...extra});
 const carrier=serviceName(r.carrier);
 if(r.manual_label_request)add(r.manual_label_request.carrier.toUpperCase(),r.manual_label_request.state,r.manual_label_request.message,r.manual_label_request.received_at,r.manual_label_request.updated_at,null,{queue:'Demandes manuelles',position:r.resolution_position});
 else if(['queued','running'].includes(r.resolution_status))add(['equivalent-preview','replace-equivalent','check-sku','compare-bc','weight','reconcile-bc'].includes(r.resolution_action)?'V3 → Erplain':'V3',r.resolution_status==='queued'?'queued':'active',r.stage||'Correction',r.resolution_since,r.resolution_updated,null,{queue:'Corrections',position:r.resolution_position});
 if(['pending','processing','review'].includes(r.erp_status))add('Erplain',r.erp_status==='processing'?'active':r.erp_status==='review'?'blocked':'queued',r.erp_status==='processing'?({creating_bc:'Création du BC',bc_created:'Contrôle du stock / préparation du BL',creating_bl:'Création du BL',ready:'Vérification finale BC / BL'})[r.phase]||'Traitement BC / BL':r.erp_status==='review'?(r.erp_error?'Préparation Erplain à corriger':r.phase==='bc_created'?'BL Erplain restant à préparer':'Préparation Erplain à recontrôler'):r.erp_position?'Préparation Erplain en attente de traitement':'Préparation Erplain en attente de validation',r.erp_since,r.erp_updated,r.erp_error,{queue:'Erplain',position:r.erp_position,queueTotal:r.erp_total||0,activeCount:r.erp_active||0,inActiveBatch:r.erp_status==='processing'});
 if(r.label_manual_request_required)add(carrier,'manual','Nouvelle demande manuelle d’étiquette attendue',null,r.carrier_updated,null);
 else if(!r.manual_label_request?.supersedesLocalRefusal&&['pending','creating','awaiting_pdf','failed','review'].includes(r.carrier_status))add(carrier,r.carrier_status==='creating'?'active':['failed','review'].includes(r.carrier_status)?'blocked':'queued',r.carrier_status==='creating'?'Création de l’étiquette':r.carrier_status==='awaiting_pdf'?'PDF attendu · récupération programmée':r.carrier_status==='pending'?'Étiquette en attente':'Étiquette bloquée',r.carrier_since,r.carrier_updated,r.carrier_error,{queue:carrier,position:r.carrier_position});
 if(r.temu_status==='ready'&&!r.external_label?.active&&!r.transport_choice)add('TEMU','queued','Achat d’étiquette TEMU à confirmer',r.temu_since,r.temu_updated);
 if(r.temu_status==='purchasing')add('TEMU','active','Achat de l’étiquette',r.temu_since,r.temu_updated);
 if(!r.external_label?.active&&!(r.manual_label_request&&r.temu_status==='shipment_error'&&!r.temu_error)&&(!r.transport_choice||['uncertain','cancellation_requested'].includes(r.temu_status))&&['uncertain','shipment_error','api_error','document_unavailable','cancellation_requested'].includes(r.temu_status))add('TEMU','blocked',({uncertain:'Résultat d’achat à rapprocher',shipment_error:'Étiquette refusée par TEMU',api_error:'Lecture TEMU en échec',document_unavailable:'PDF TEMU indisponible',cancellation_requested:'Annulation TEMU à rapprocher'})[r.temu_status],r.temu_since,r.temu_updated,r.temu_error||'Vérification nécessaire dans TEMU');
 if(r.temu_sync_status==='running')add('TEMU','active','Lecture des expéditions et documents',r.temu_sync_since,r.temu_sync_updated);
 if(['review','failed','cancelled'].includes(r.resolution_status)&&r.resolution_error)add('V3','blocked',r.stage||'Correction à vérifier',r.resolution_since,r.resolution_updated,r.resolution_error);
 if(r.resolution_status==='waiting'&&!activities.some(a=>a.service==='Erplain'||a.service===carrier))add('V3','queued',r.stage||'Suite du traitement en attente',r.resolution_since,r.resolution_updated);
 if(r.suspension?.active)add('V3','blocked','Commande suspendue',r.suspension.suspendedAt||null,null,r.suspension.reason||'Suspension active');
 const previewPending=r.resolution_action==='equivalent-preview'&&r.resolution_status==='complete'&&r.preview_original_present&&r.resolution_result?.replacementSku&&!r.resolution_result?.reconcileOnly?{sku:r.resolution_result.replacementSku,quantity:r.resolution_result.replacementQuantity,checkedAt:r.resolution_updated}:null;
 const main=activities.find(a=>a.state==='active')||activities.find(a=>a.state==='blocked')||activities[0];
 if(!main)return {...base,activities,previewPending};
 return {...base,...main,stage:main.service+' · '+main.step,activities,previewPending};
}
