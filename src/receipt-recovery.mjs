import {initializeReceiptWarehouse,receiptWarehouseExports} from './receipt-warehouse-export.mjs';
import {receiptCandidates,receiptWork} from './receipt-candidates.mjs';
import {randomUUID} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';
import {readReceipt,readReceiptRelatedBcs,refreshReceiptBcs} from './receipt-recovery-read.mjs';
import {validateReceiptNumber,receiptHash,buildReceiptPlan,receiptOrderBlock,recoveryFingerprint} from './receipt-recovery-plan.mjs';
import {queueResolutionRequest} from './resolution-request.mjs';
import {queueLabelFromBl} from './direct-label.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {temuLocalService} from './temu-local.mjs';
import {receiptAnalysis} from './receipt-analysis.mjs';
import {receiptOutcome} from './receipt-outcome.mjs';

export async function initializeReceiptRecovery(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS receipt_recovery_runs(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,number text NOT NULL,state text NOT NULL DEFAULT 'queued',plan jsonb,error text,selection jsonb,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS receipt_recovery_one_execution ON receipt_recovery_runs((1)) WHERE state='applying';
 CREATE TABLE IF NOT EXISTS receipt_recovery_items(run_id text NOT NULL REFERENCES receipt_recovery_runs(id),order_id text NOT NULL REFERENCES orders(id),request_id text NOT NULL UNIQUE,state text NOT NULL DEFAULT 'selected',resolution_id text,error text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,order_id));`);
 await db.exec("ALTER TABLE receipt_recovery_runs ADD COLUMN IF NOT EXISTS progress jsonb DEFAULT '{}'");
 await db.exec("ALTER TABLE receipt_recovery_runs ADD COLUMN IF NOT EXISTS read_checkpoint jsonb DEFAULT '{}'");
 await initializeReceiptWarehouse(db);
}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export async function recoveryOrders(db,ids=null){
 return (await db.query(`SELECT o.*,
 EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.order_id=o.id) AS "hasPartial",
 (EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing') OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting')) OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status IN ('creating','pending','awaiting_pdf')) OR EXISTS(SELECT 1 FROM correction_jobs j WHERE j.order_id=o.id AND j.status IN ('queued','applying','checking','waiting'))) AS busy,
 (SELECT jsonb_agg(DISTINCT sku) FROM lines l LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku CROSS JOIN LATERAL unnest(ARRAY[l.source_sku,l.target_sku,m.target_sku]) sku WHERE l.order_id=o.id AND sku IS NOT NULL) AS skus
 FROM orders o WHERE ($1::text[] IS NULL OR o.id=ANY($1)) AND NOT o.archived AND o.reference NOT LIKE 'DEMO-%'`,[ids])).rows;
}
export async function recoveryLabels(db,o){
 const rows=[];
 for(const d of (await db.query("SELECT d.document_index,c.tracking FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.environment='production' AND c.status='ready' ORDER BY d.document_index",[o.id])).rows)rows.push({name:'Étiquette '+(d.document_index+1),url:'/api/carriers/documents/'+encodeURIComponent(o.id)+'/'+d.document_index,tracking:d.tracking||[]});
 for(const d of (await db.query('SELECT package FROM temu_label_documents WHERE reference=$1 ORDER BY package',[o.reference])).rows)rows.push({name:'Étiquette TEMU '+d.package,url:'/api/temu/pdf?reference='+encodeURIComponent(o.reference)+'&package='+encodeURIComponent(d.package)});
 for(const d of (await db.query("SELECT d.delivery_id,d.document_index FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 AND p.status NOT IN ('cancelled','review') ORDER BY d.delivery_id,d.document_index",[o.id])).rows)rows.push({name:'Étiquette livraison partielle',url:'/api/partial/documents/'+encodeURIComponent(d.delivery_id)+'/'+d.document_index});
 return rows;
}
function snapshotLabelLinks(o){
 return [
  ...(o.carrier_documents||[]).map(d=>({name:'Étiquette '+(d.document_index+1),url:'/api/carriers/documents/'+encodeURIComponent(o.id)+'/'+d.document_index,tracking:d.tracking||[]})),
  ...(o.temu_documents||[]).map(d=>({name:'Étiquette TEMU '+d.package,url:'/api/temu/pdf?reference='+encodeURIComponent(o.reference)+'&package='+encodeURIComponent(d.package)})),
  ...(o.partial_documents||[]).map(d=>({name:'Étiquette livraison partielle',url:'/api/partial/documents/'+encodeURIComponent(d.delivery_id)+'/'+d.document_index}))
 ];
}
export function receiptRecoveryService(db,directory,{api:providedApi,queueResolution=queueResolutionRequest,queueLabel=queueLabelFromBl,enabled=()=>true,temu=temuLocalService(db,directory)}={}){
 const api=providedApi||erplainAccount(directory,'source');
 const warehouse=receiptWarehouseExports(db,directory);
 let running=false,activeItem=null;
 async function preview(number,onProgress=async()=>{},reader=api){
  await onProgress({phase:'receipt',message:'Lecture de la réception Erplain'});
  const receipts=await readReceipt(reader,number);await onProgress({phase:'local',message:'Recherche des commandes V3 concernées'});
  const allOrders=await recoveryOrders(db),{bcs,errors,mode}=await readReceiptRelatedBcs(reader,allOrders,receipts),localIds=new Set(receiptCandidates(receipts,allOrders,{includeUnknown:false}).map(o=>o.id)),orders=allOrders.filter(o=>bcs.has(String(o.erp_live?.bc?.id))||localIds.has(o.id)||errors.has(o.id));
  // Collection snapshots may contain an older delivery status. Refresh only
  // receipt-related BCs, without comparing commercial data or mutating ERPLAIN.
  const candidates=buildReceiptPlan(receipts,orders,bcs,{errors}).rows;
  await onProgress({phase:'documents',done:0,total:candidates.length,message:candidates.length+' commandes concernées : vérification des BL'});
  const candidateIds=new Set(candidates.map(o=>o.id));if(!errors.size)await refreshReceiptBcs(reader,orders.filter(o=>candidateIds.has(o.id)),bcs,errors,onProgress);
  const plan=buildReceiptPlan(receipts,orders,bcs,{errors});plan.coverage={orders:allOrders.length,candidates:orders.length,bcs:bcs.size,errors:errors.size,complete:errors.size===0,mode};plan.receiptFingerprint=receiptHash(receipts);
  return plan;
 }
 async function itemState(run,id,state,error=null,resolutionId=null){await db.query('UPDATE receipt_recovery_items SET state=$3,error=$4,resolution_id=coalesce($5,resolution_id),updated_at=now() WHERE run_id=$1 AND order_id=$2',[run,id,state,error,resolutionId]);}
 async function status(id){
  const run=(await db.query('SELECT * FROM receipt_recovery_runs WHERE id=$1',[id])).rows[0];if(!run)throw Error('Analyse de réception introuvable');
  const items=(await db.query('SELECT * FROM receipt_recovery_items WHERE run_id=$1 ORDER BY updated_at,order_id',[id])).rows;
  const ids=(run.plan?.rows||[]).map(r=>r.id);
  const snapshot=(await db.query(`SELECT o.id,o.reference,o.channel,o.archived,o.tracking_status,o.label_status,o.suspension,o.partial_mode,o.erp_live,o.parcel_count,EXISTS(SELECT 1 FROM resolution_jobs active WHERE active.order_id=o.id AND active.status IN ('queued','running','waiting')) AS label_busy,t.error AS temu_error,
   CASE WHEN o.channel='temu' THEN (SELECT count(*) FROM temu_label_documents d WHERE d.reference=o.reference AND octet_length(d.pdf)>0) ELSE (SELECT count(*) FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=o.id AND c.environment='production' AND c.status='ready' AND octet_length(d.pdf)>0) END AS pdf_count,
   greatest(coalesce(o.parcel_count,1),coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(t.packages)='array' THEN t.packages ELSE '[]'::jsonb END),0),coalesce((SELECT jsonb_array_length(CASE WHEN jsonb_typeof(c.tracking)='array' THEN c.tracking ELSE '[]'::jsonb END) FROM carrier_jobs c WHERE c.order_id=o.id AND c.environment='production'),0),1) AS expected_pdfs,
   EXISTS(SELECT 1 FROM extra_parcels e WHERE e.order_id=o.id AND e.environment='production' AND e.status NOT IN ('cancelled','superseded') AND (e.status<>'ready' OR coalesce(octet_length(e.pdf),0)=0)) AS extra_incomplete,
   (SELECT jsonb_agg(jsonb_build_object('document_index',d.document_index,'tracking',c.tracking) ORDER BY d.document_index) FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=o.id AND c.environment='production' AND c.status='ready') AS carrier_documents,
   (SELECT jsonb_agg(jsonb_build_object('package',d.package) ORDER BY d.package) FROM temu_label_documents d WHERE d.reference=o.reference) AS temu_documents,
   (SELECT jsonb_agg(jsonb_build_object('delivery_id',d.delivery_id,'document_index',d.document_index)) FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=o.id AND p.status NOT IN ('cancelled','review')) AS partial_documents
   FROM orders o LEFT JOIN temu_label_jobs t ON t.reference=o.reference AND o.channel='temu' WHERE o.id=ANY($1::text[])`,[ids])).rows;
  const jobs=(await db.query('SELECT id,status,stage,error FROM resolution_jobs WHERE id=ANY($1::text[])',[items.map(i=>i.resolution_id).filter(Boolean)])).rows;
  const byOrder=new Map(snapshot.map(o=>[o.id,o])),byJob=new Map(jobs.map(j=>[j.id,j])),byItem=new Map(items.map(i=>[i.order_id,i]));
  const rows=[];for(const row of run.plan?.rows||[]){const o=byOrder.get(row.id),item=byItem.get(row.id),job=byJob.get(item?.resolution_id)||null;
   const labels=o?snapshotLabelLinks(o):[];
   const confirmedBl=row.bls?.find(b=>String(b.id)===String(o?.erp_live?.bl?.id));
   const currentBl=confirmedBl||o?.erp_live?.bl;
   const canLabel=!!(currentBl?.id&&currentBl.status!=='cancelled'&&o?.erp_live?.bl?.status!=='cancelled'&&!labels.length&&!suspensionBlock(o)&&!o?.archived&&!o?.partial_mode&&!o?.label_busy&&!['cancelled','shipped','in_transit','delivered','delivered_simulated'].includes(o?.tracking_status)&&o?.label_status!=='cancelled'&&!['shipped','delivered','completed'].includes(currentBl.status));
   rows.push({...row,canLabel,...(canLabel?{status:'documents',action:'label'}:{}),labels,reason:row.status==='documents'?(labels.length?'BL et étiquettes disponibles · aucune nouvelle génération nécessaire':'BL déjà disponible · étiquette à obtenir'):row.reason,labelError:o?.temu_error||null,currentBl:confirmedBl|| (o?.erp_live?.bl?{id:o.erp_live.bl.id,label:o.erp_live.bl.label,status:o.erp_live.bl.status}:null),item:item?{state:item.state,error:item.error,job}:null});
  }
  for(const row of rows){
   const o=byOrder.get(row.id);
   row.documentsComplete=!!(o&&!o.partial_mode&&row.currentBl?.id&&row.currentBl?.label&&row.currentBl.status!=='cancelled'&&o.erp_live?.bl?.status!=='cancelled'&&row.labels.length&&Number(o.pdf_count)>=Number(o.expected_pdfs)&&!o.extra_incomplete);
   row.work=o?.label_status==='cancelled'||o?.erp_live?.bl?.status==='cancelled'?'history':receiptWork(row,o);
   if(row.work==='available')row.reason='BL et étiquettes disponibles · état du BL conservé, aucune nouvelle génération nécessaire';
   else if(row.labels.length&&!row.currentBl?.id)row.reason='Étiquette disponible · BL manquant : préparation non finalisée'+(row.status!=='documents'&&row.reason?' · '+row.reason:'');
   else if(row.labels.length&&!row.documentsComplete)row.reason='Documents incomplets · vérifier les PDF de tous les colis'+(row.reason&&row.status!=='documents'?' · '+row.reason:'');
  }
  return {id:run.id,number:run.number,state:run.state,error:run.error,selection:run.selection,progress:run.progress,createdAt:run.created_at,updatedAt:run.updated_at,outcome:receiptOutcome(run,rows),plan:run.plan?{...run.plan,rows}:null};
 }
 async function submit({id,ids},user){
  if(!uuid(id)||!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(x=>!uuid(x))||new Set(ids).size!==ids.length)throw Error('Sélectionner de 1 à 100 commandes distinctes');
  const displayed=await status(id);
  return db.transaction(async tx=>{
   const r=(await tx.query('SELECT * FROM receipt_recovery_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)throw Error('Analyse introuvable');
   const selection=[...ids].sort();if(r.selection){if(JSON.stringify(r.selection)!==JSON.stringify(selection))throw Error('Cette analyse a déjà été lancée avec une autre sélection');return {id,state:r.state,existing:true};}
   const labelOnly=ids.every(id=>displayed.plan?.rows.some(row=>row.id===id&&row.action==='label'));
   if(r.state!=='ready'||!labelOnly&&(!r.plan?.coverage?.complete||Date.now()-Date.parse(r.updated_at)>30*60*1000))throw Error('Relancer une analyse complète et récente avant le traitement');
   if(ids.some(id=>!displayed.plan.rows.some(row=>row.id===id&&(row.status==='eligible'||row.status==='documents'&&row.canLabel))))throw Error('La sélection contient une commande non admissible');
   if((await tx.query("SELECT id FROM receipt_recovery_runs WHERE state='applying'")).rows.length)throw Error('Une autre réception est en traitement : attendre son résultat');
   for(const orderId of ids)await tx.query('INSERT INTO receipt_recovery_items(run_id,order_id,request_id) VALUES($1,$2,$3)',[id,orderId,randomUUID()]);
   const plan={...r.plan,rows:r.plan.rows.map(row=>{const live=displayed.plan.rows.find(x=>x.id===row.id);return ids.includes(row.id)&&live?.action==='label'?{...row,action:'label'}:row;})};
   await tx.query("UPDATE receipt_recovery_runs SET state='applying',selection=$2,plan=$3,updated_at=now() WHERE id=$1",[id,JSON.stringify(selection),JSON.stringify(plan)]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'receipt.recovery.requested',$2)",[user.email,JSON.stringify({runId:id,number:r.number,ids:selection})]);return {id,state:'applying'};
  });
 }
 async function advance(run){
  const items=(await db.query("SELECT * FROM receipt_recovery_items WHERE run_id=$1 AND state NOT IN ('complete','blocked','label_action_required') ORDER BY (SELECT processing_priority_at FROM orders WHERE id=order_id) ASC NULLS LAST,(SELECT received_at FROM orders WHERE id=order_id),order_id",[run.id])).rows;
  if(!items.length){await db.query("UPDATE receipt_recovery_runs SET state='finished',updated_at=now() WHERE id=$1",[run.id]);return;}
  const item=items[0];activeItem=item.order_id;const o=(await recoveryOrders(db,[item.order_id]))[0];if(!o){await itemState(run.id,item.order_id,'blocked','Commande archivée ou introuvable');return;}
  if(suspensionBlock(o)){await itemState(run.id,o.id,'blocked',suspensionBlock(o));return;}
  if(item.state==='selected'){
   const original=run.plan.rows.find(r=>r.id===o.id);
   if(original?.action==='label'||original?.status==='documents'&&original.canLabel){
    if(['cancelled','shipped','in_transit','delivered'].includes(o.tracking_status)||o.label_status==='cancelled')throw Error('Commande annulée ou déjà expédiée');
    if((await recoveryLabels(db,o)).length){await itemState(run.id,o.id,'complete');return;}
    if(o.channel==='temu'){const t=(await db.query('SELECT error FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];await itemState(run.id,o.id,'label_action_required',t?.error||'Obtenir l’étiquette dans le parcours TEMU.');return;}
    await queueLabel(db,o.id,{email:run.created_by});await itemState(run.id,o.id,'label_pending');return;
   }
   const prior=(await db.query('SELECT id FROM resolution_jobs WHERE request_id=$1',[item.request_id])).rows[0];if(prior){await itemState(run.id,o.id,'preparing',null,prior.id);return;}
   await withShipmentLock(async()=>{
    if(!enabled())return;
    const fresh=(await recoveryOrders(db,[o.id]))[0],receipts=await readReceipt(api,run.number);
    if(receiptHash(receipts)!==run.plan.receiptFingerprint)throw Error('Réception modifiée : relancer son analyse');
    const bc=await readErplainDocuments(api,fresh.erp_live?.bc?.id),original=run.plan.rows.find(r=>r.id===o.id);
    if(recoveryFingerprint(fresh,bc)!==original.fingerprint)throw Error('Préparation modifiée depuis l’analyse : relancer son analyse');
    const reason=receiptOrderBlock(fresh,bc);if(reason)throw Error(reason);
    const check=buildReceiptPlan(receipts,[fresh],new Map([[String(bc.id),bc]]));if(check.rows[0]?.status!=='eligible')throw Error(check.rows[0]?.reason||'Commande non liée à cette réception');
    const result=await queueResolution(db,{id:o.id,requestId:item.request_id,action:'resume-erp',type:'stock'},{email:run.created_by});
    const queued=(await db.query('SELECT request_id FROM resolution_jobs WHERE id=$1',[result.id])).rows[0];if(queued?.request_id!==item.request_id)throw Error('Une autre intervention a démarré : attendre son résultat');
    await itemState(run.id,o.id,'preparing',null,result.id);
   });return;
  }
  if(item.state==='label_pending'){
   if((await recoveryLabels(db,o)).length){await itemState(run.id,o.id,'complete');return;}
   const c=(await db.query('SELECT status,error FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];if(!c||['failed','review','superseded'].includes(c.status))await itemState(run.id,o.id,'blocked',c?.error||'Étiquette non disponible : rapprocher le résultat');return;
  }
  const resolution=(await db.query('SELECT status,error FROM resolution_jobs WHERE id=$1',[item.resolution_id])).rows[0];
  if(!resolution){await itemState(run.id,o.id,'blocked','Intervention de reprise introuvable');return;}
  if(['queued','running','waiting'].includes(resolution.status))return;
  if(resolution.status!=='complete'||resolution.error){await itemState(run.id,o.id,'blocked',resolution.error||'Préparation à vérifier');return;}
  if(item.state==='preparing'){
   if(!o.erp_live?.bl?.id){await itemState(run.id,o.id,'blocked','BL absent après préparation');return;}
   const labels=await recoveryLabels(db,o);if(labels.length){await itemState(run.id,o.id,'complete');return;}
   if(o.channel==='temu'){
    const t=(await db.query('SELECT status,error FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];
    await itemState(run.id,o.id,'label_action_required',t?.error||'BL prêt. Obtenir l’étiquette dans le parcours TEMU ; aucun achat automatique depuis ce module.');return;
   }
   await queueLabel(db,o.id,{email:run.created_by});await itemState(run.id,o.id,'label_pending');return;
  }
 }
 return {get running(){return running;},preview,status,submit,
  async run(){if(running||!enabled())return;running=true;let run;
   try{
    run=(await db.query("SELECT * FROM receipt_recovery_runs WHERE state IN ('queued','reading','applying') ORDER BY CASE WHEN state='reading' THEN 0 WHEN state='queued' THEN 1 ELSE 2 END,created_at LIMIT 1")).rows[0];if(!run){await warehouse.advance();return;}
   if(run.state==='applying'){activeItem=null;try{await advance(run);}catch(e){if(activeItem)await itemState(run.id,activeItem,'blocked',e.message);else throw e;}return;}
    const attempt=randomUUID();await db.query("UPDATE receipt_recovery_runs SET state='reading',error=null,progress=$2,updated_at=now() WHERE id=$1",[run.id,JSON.stringify({attempt,startedAt:new Date().toISOString(),message:'Démarrage de l’analyse'})]);
    const controller=new AbortController(),analysisApi=providedApi||erplainAccount(directory,'source',{fetchImpl:(url,options)=>fetch(url,{...options,signal:AbortSignal.any([options.signal,controller.signal])})});
    let plan;try{plan=await receiptAnalysis(analysisApi,(reader,report)=>preview(run.number,report,reader),{checkpoint:run.read_checkpoint,
     save:cache=>db.query("UPDATE receipt_recovery_runs SET read_checkpoint=$2 WHERE id=$1 AND state='reading' AND progress->>'attempt'=$3",[run.id,JSON.stringify(cache),attempt]),
     progress:p=>db.query("UPDATE receipt_recovery_runs SET progress=progress || $2::jsonb,updated_at=now() WHERE id=$1 AND state='reading' AND progress->>'attempt'=$3",[run.id,JSON.stringify(p),attempt])});}finally{controller.abort();}
    await db.query("UPDATE receipt_recovery_runs SET state='ready',plan=$2,error=$3,updated_at=now() WHERE id=$1",[run.id,JSON.stringify(plan),plan.coverage.complete?null:'Analyse incomplète : certaines lectures Erplain ont été différées. Reprendre l’analyse.']);
   }catch(e){if(run)await db.query("UPDATE receipt_recovery_runs SET state='failed',error=$2,updated_at=now() WHERE id=$1",[run.id,e.message]);}finally{running=false;}
  },
  async routes({p,url,req,res,user,body,json,permitted}){
   if(await warehouse.routes({p,url,req,res,user,body,json,permitted}))return true;
   if(!p.startsWith('/api/receipts/recovery'))return false;
   permitted(user,['admin','manager','operator']);
   if(['/api/receipts/recovery/temu/quote','/api/receipts/recovery/temu/buy'].includes(p)&&req.method==='POST'){
    permitted(user,['admin','manager']);const b=await body(req),run=await status(b.id),row=run.plan?.rows.find(row=>row.id===b.orderId);
    if(!row||row.channel!=='temu'||!row.canLabel||row.labels.length)throw Error('Aucune étiquette TEMU à créer pour cette commande');
    if(p.endsWith('/quote')){const plan=await temu.prepare(row.reference);json(res,200,{reference:row.reference,planId:plan.id,amount:plan.amount,currency:plan.currency});return true;}
    if(b.confirmPurchase!==true)throw Error('Confirmation du tarif TEMU requise');
    await db.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'temu.purchase.requested',$2)",[user.email,JSON.stringify({reference:row.reference,planId:b.planId,amount:b.amount,source:'receipt_recovery',runId:b.id})]);
    const result=await temu.buy(row.reference,b.planId,b.amount);json(res,200,result);return true;
   }
   if(p==='/api/receipts/recovery'&&req.method==='GET'){json(res,200,{rows:(await db.query("SELECT id,number,state,error,created_at,plan->'coverage'->>'complete' AS analysis_complete FROM receipt_recovery_runs ORDER BY created_at DESC LIMIT 20")).rows});return true;}
   if(p==='/api/receipts/recovery/resume'&&req.method==='POST'){
    permitted(user,['admin','manager']);const b=await body(req);if(!uuid(b.id))throw Error('Analyse introuvable');
    const result=await db.query("UPDATE receipt_recovery_runs SET state='queued',error=null,updated_at=now() WHERE id=$1 AND selection IS NULL AND (state='failed' OR state='ready' AND coalesce(plan->'coverage'->>'complete','false')<>'true') RETURNING id",[b.id]);
    if(!result.rows.length)throw Error('Cette analyse ne peut pas être reprise : actualiser son résultat');json(res,202,{id:b.id});return true;
   }
   if(p==='/api/receipts/recovery/status'&&req.method==='GET'){json(res,200,await status(url.searchParams.get('id')));return true;}
   if(p==='/api/receipts/recovery/preview'&&req.method==='POST'){
    const b=await body(req),number=validateReceiptNumber(b.number);if(!uuid(b.requestId))throw Error('Identifiant de demande requis');
    const previous=(await db.query('SELECT id,number FROM receipt_recovery_runs WHERE request_id=$1',[b.requestId])).rows[0];if(previous){if(previous.number!==number)throw Error('Identifiant déjà utilisé pour une autre réception');json(res,202,{id:previous.id,existing:true});return true;}
    const result=await withShipmentLock(async()=>{
     const active=(await db.query("SELECT id FROM receipt_recovery_runs WHERE upper(number)=upper($1) AND state IN ('queued','reading','applying') ORDER BY created_at LIMIT 1",[number])).rows[0];
     if(active)return {id:active.id,existing:true};
     const id=randomUUID();await db.query('INSERT INTO receipt_recovery_runs(id,request_id,number,created_by) VALUES($1,$2,$3,$4)',[id,b.requestId,number,user.email]);return {id};
    },['receipt-preview:'+number.toUpperCase()]);json(res,202,result);return true;
   }
   if(p==='/api/receipts/recovery/execute'&&req.method==='POST'){permitted(user,['admin','manager']);json(res,202,await submit(await body(req),user));return true;}
   return false;
  }
 };
}
