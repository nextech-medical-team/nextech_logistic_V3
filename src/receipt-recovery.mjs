import {randomUUID} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';
import {readReceipt,readRecoveryBcs} from './receipt-recovery-read.mjs';
import {validateReceiptNumber,receiptHash,buildReceiptPlan,receiptOrderBlock,recoveryFingerprint} from './receipt-recovery-plan.mjs';
import {queueResolutionRequest} from './resolution-request.mjs';
import {queueLabelFromBl} from './direct-label.mjs';
import {suspensionBlock} from './order-suspension.mjs';

export async function initializeReceiptRecovery(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS receipt_recovery_runs(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,number text NOT NULL,state text NOT NULL DEFAULT 'queued',plan jsonb,error text,selection jsonb,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS receipt_recovery_one_execution ON receipt_recovery_runs((1)) WHERE state='applying';
 CREATE TABLE IF NOT EXISTS receipt_recovery_items(run_id text NOT NULL REFERENCES receipt_recovery_runs(id),order_id text NOT NULL REFERENCES orders(id),request_id text NOT NULL UNIQUE,state text NOT NULL DEFAULT 'selected',resolution_id text,error text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,order_id));`);
}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export async function recoveryOrders(db,ids=null){
 return (await db.query(`SELECT o.*,
 EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.order_id=o.id) AS "hasPartial",
 (EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing') OR EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting')) OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status IN ('creating','pending','awaiting_pdf')) OR EXISTS(SELECT 1 FROM correction_jobs j WHERE j.order_id=o.id AND j.status IN ('queued','applying','checking','waiting'))) AS busy,
 (SELECT jsonb_agg(DISTINCT coalesce(l.target_sku,m.target_sku,l.source_sku)) FROM lines l LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=o.id) AS skus
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
export function receiptRecoveryService(db,directory,{api=erplainAccount(directory,'source'),queueResolution=queueResolutionRequest,queueLabel=queueLabelFromBl,enabled=()=>true}={}){
 let running=false,activeItem=null;
 async function preview(number){
  const receipts=await readReceipt(api,number),orders=await recoveryOrders(db),{bcs,errors}=await readRecoveryBcs(api,orders);
  // Collection snapshots may contain an older delivery status. Refresh only
  // receipt-related BCs, without comparing commercial data or mutating ERPLAIN.
  const candidates=buildReceiptPlan(receipts,orders,bcs,{errors}).rows;
  for(const row of candidates){const o=orders.find(o=>o.id===row.id);if(!o?.erp_live?.bc?.id)continue;
   try{bcs.set(String(o.erp_live.bc.id),await readErplainDocuments(api,o.erp_live.bc.id));errors.delete(o.id);}
   catch(e){errors.set(o.id,'Lecture du document indisponible : '+e.message);if(e.httpStatus===429||e.httpStatus>=500)break;}
  }
  const plan=buildReceiptPlan(receipts,orders,bcs,{errors});plan.coverage={orders:orders.length,bcs:bcs.size,errors:errors.size,complete:errors.size===0};plan.receiptFingerprint=receiptHash(receipts);
  return plan;
 }
 async function itemState(run,id,state,error=null,resolutionId=null){await db.query('UPDATE receipt_recovery_items SET state=$3,error=$4,resolution_id=coalesce($5,resolution_id),updated_at=now() WHERE run_id=$1 AND order_id=$2',[run,id,state,error,resolutionId]);}
 async function status(id){
  const run=(await db.query('SELECT * FROM receipt_recovery_runs WHERE id=$1',[id])).rows[0];if(!run)throw Error('Analyse de réception introuvable');
  const items=(await db.query('SELECT * FROM receipt_recovery_items WHERE run_id=$1 ORDER BY updated_at,order_id',[id])).rows;
  const ids=(run.plan?.rows||[]).map(r=>r.id);
  const snapshot=(await db.query(`SELECT o.id,o.reference,o.channel,o.erp_live,t.error AS temu_error,
   (SELECT jsonb_agg(jsonb_build_object('document_index',d.document_index,'tracking',c.tracking) ORDER BY d.document_index) FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=o.id AND c.environment='production' AND c.status='ready') AS carrier_documents,
   (SELECT jsonb_agg(jsonb_build_object('package',d.package) ORDER BY d.package) FROM temu_label_documents d WHERE d.reference=o.reference) AS temu_documents,
   (SELECT jsonb_agg(jsonb_build_object('delivery_id',d.delivery_id,'document_index',d.document_index)) FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=o.id AND p.status NOT IN ('cancelled','review')) AS partial_documents
   FROM orders o LEFT JOIN temu_label_jobs t ON t.reference=o.reference AND o.channel='temu' WHERE o.id=ANY($1::text[])`,[ids])).rows;
  const jobs=(await db.query('SELECT id,status,stage,error FROM resolution_jobs WHERE id=ANY($1::text[])',[items.map(i=>i.resolution_id).filter(Boolean)])).rows;
  const byOrder=new Map(snapshot.map(o=>[o.id,o])),byJob=new Map(jobs.map(j=>[j.id,j])),byItem=new Map(items.map(i=>[i.order_id,i]));
  const rows=[];for(const row of run.plan?.rows||[]){const o=byOrder.get(row.id),item=byItem.get(row.id),job=byJob.get(item?.resolution_id)||null;
   const labels=o?snapshotLabelLinks(o):[];
   const confirmedBl=row.bls?.find(b=>String(b.id)===String(o?.erp_live?.bl?.id));
   rows.push({...row,labels,reason:row.status==='documents'?(labels.length?'BL et étiquettes disponibles · aucune nouvelle génération nécessaire':'BL déjà disponible · étiquette à obtenir'):row.reason,labelError:o?.temu_error||null,currentBl:confirmedBl|| (o?.erp_live?.bl?{id:o.erp_live.bl.id,label:o.erp_live.bl.label,status:o.erp_live.bl.status}:null),item:item?{state:item.state,error:item.error,job}:null});
  }
  return {id:run.id,number:run.number,state:run.state,error:run.error,createdAt:run.created_at,updatedAt:run.updated_at,plan:run.plan?{...run.plan,rows}:null};
 }
 async function submit({id,ids},user){
  if(!uuid(id)||!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(x=>!uuid(x))||new Set(ids).size!==ids.length)throw Error('Sélectionner de 1 à 100 commandes distinctes');
  return db.transaction(async tx=>{
   const r=(await tx.query('SELECT * FROM receipt_recovery_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)throw Error('Analyse introuvable');
   const selection=[...ids].sort();if(r.selection){if(JSON.stringify(r.selection)!==JSON.stringify(selection))throw Error('Cette analyse a déjà été lancée avec une autre sélection');return {id,state:r.state,existing:true};}
   if(r.state!=='ready'||!r.plan?.coverage?.complete||Date.now()-Date.parse(r.updated_at)>30*60*1000)throw Error('Relancer une analyse complète et récente avant le traitement');
   if(ids.some(id=>!r.plan.rows.some(row=>row.id===id&&(row.status==='eligible'||row.status==='documents'&&row.canLabel))))throw Error('La sélection contient une commande non admissible');
   if((await tx.query("SELECT id FROM receipt_recovery_runs WHERE state='applying'")).rows.length)throw Error('Une autre réception est en traitement : attendre son résultat');
   for(const orderId of ids)await tx.query('INSERT INTO receipt_recovery_items(run_id,order_id,request_id) VALUES($1,$2,$3)',[id,orderId,randomUUID()]);
   await tx.query("UPDATE receipt_recovery_runs SET state='applying',selection=$2,updated_at=now() WHERE id=$1",[id,JSON.stringify(selection)]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'receipt.recovery.requested',$2)",[user.email,JSON.stringify({runId:id,number:r.number,ids:selection})]);return {id,state:'applying'};
  });
 }
 async function advance(run){
  const items=(await db.query("SELECT * FROM receipt_recovery_items WHERE run_id=$1 AND state NOT IN ('complete','blocked','label_action_required') ORDER BY (SELECT processing_priority_at FROM orders WHERE id=order_id) ASC NULLS LAST,(SELECT received_at FROM orders WHERE id=order_id),order_id",[run.id])).rows;
  if(!items.length){await db.query("UPDATE receipt_recovery_runs SET state='finished',updated_at=now() WHERE id=$1",[run.id]);return;}
  const item=items[0];activeItem=item.order_id;const o=(await recoveryOrders(db,[item.order_id]))[0];if(!o){await itemState(run.id,item.order_id,'blocked','Commande archivée ou introuvable');return;}
  if(suspensionBlock(o)){await itemState(run.id,o.id,'blocked',suspensionBlock(o));return;}
  if(item.state==='selected'){
   const prior=(await db.query('SELECT id FROM resolution_jobs WHERE request_id=$1',[item.request_id])).rows[0];if(prior){await itemState(run.id,o.id,'preparing',null,prior.id);return;}
   await withShipmentLock(async()=>{
    if(!enabled())return;
    const fresh=(await recoveryOrders(db,[o.id]))[0],receipts=await readReceipt(api,run.number);
    if(receiptHash(receipts)!==run.plan.receiptFingerprint)throw Error('Réception modifiée : relancer son analyse');
    const bc=await readErplainDocuments(api,fresh.erp_live?.bc?.id),original=run.plan.rows.find(r=>r.id===o.id);
    if(recoveryFingerprint(fresh,bc)!==original.fingerprint)throw Error('Préparation modifiée depuis l’analyse : relancer son analyse');
    if(original.status==='documents'&&original.canLabel){
     const check=buildReceiptPlan(receipts,[fresh],new Map([[String(bc.id),bc]])).rows[0];if(!check?.canLabel)throw Error('BL ou commande non admissible pour une étiquette');
     if((await recoveryLabels(db,fresh)).length){await itemState(run.id,o.id,'complete');return;}
     if(o.channel==='temu'){const t=(await db.query('SELECT error FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];await itemState(run.id,o.id,'label_action_required',t?.error||'Obtenir l’étiquette dans le parcours TEMU.');return;}
     await queueLabel(db,o.id,{email:run.created_by});await itemState(run.id,o.id,'label_pending');return;
    }
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
   await api.verify();const bc=await readErplainDocuments(api,o.erp_live.bc.id),bl=bc.shipping_orders.data.find(b=>String(b.id)===String(o.erp_live?.bl?.id));
   if(!bl||!['ready_to_ship','shipped','delivered','completed'].includes(bl.status)){await itemState(run.id,o.id,'blocked','BL non confirmé prêt : '+(bl?.status||'absent'));return;}
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
    run=(await db.query("SELECT * FROM receipt_recovery_runs WHERE state IN ('queued','reading','applying') ORDER BY CASE WHEN state='reading' THEN 0 WHEN state='queued' THEN 1 ELSE 2 END,created_at LIMIT 1")).rows[0];if(!run)return;
   if(run.state==='applying'){activeItem=null;try{await advance(run);}catch(e){if(activeItem)await itemState(run.id,activeItem,'blocked',e.message);else throw e;}return;}
    await db.query("UPDATE receipt_recovery_runs SET state='reading',updated_at=now() WHERE id=$1",[run.id]);const plan=await preview(run.number);
    await db.query("UPDATE receipt_recovery_runs SET state='ready',plan=$2,error=null,updated_at=now() WHERE id=$1",[run.id,JSON.stringify(plan)]);
   }catch(e){if(run)await db.query("UPDATE receipt_recovery_runs SET state='failed',error=$2,updated_at=now() WHERE id=$1",[run.id,e.message]);}finally{running=false;}
  },
  async routes({p,url,req,res,user,body,json,permitted}){
   if(!p.startsWith('/api/receipts/recovery'))return false;
   permitted(user,['admin','manager','operator']);
   if(p==='/api/receipts/recovery'&&req.method==='GET'){json(res,200,{rows:(await db.query('SELECT id,number,state,error,created_at FROM receipt_recovery_runs ORDER BY created_at DESC LIMIT 20')).rows});return true;}
   if(p==='/api/receipts/recovery/status'&&req.method==='GET'){json(res,200,await status(url.searchParams.get('id')));return true;}
   if(p==='/api/receipts/recovery/preview'&&req.method==='POST'){
    const b=await body(req),number=validateReceiptNumber(b.number);if(!uuid(b.requestId))throw Error('Identifiant de demande requis');
    const previous=(await db.query('SELECT id,number FROM receipt_recovery_runs WHERE request_id=$1',[b.requestId])).rows[0];if(previous){if(previous.number!==number)throw Error('Identifiant déjà utilisé pour une autre réception');json(res,202,{id:previous.id,existing:true});return true;}
    const id=randomUUID();await db.query('INSERT INTO receipt_recovery_runs(id,request_id,number,created_by) VALUES($1,$2,$3,$4)',[id,b.requestId,number,user.email]);json(res,202,{id});return true;
   }
   if(p==='/api/receipts/recovery/execute'&&req.method==='POST'){permitted(user,['admin','manager']);json(res,202,await submit(await body(req),user));return true;}
   return false;
  }
 };
}
