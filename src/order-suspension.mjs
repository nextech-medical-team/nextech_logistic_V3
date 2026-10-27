import {randomUUID} from 'node:crypto';
import {localOrderBusy} from './order-local-transaction.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';
import {erplainLifecycleGateway} from './erplain-lifecycle-gateway.mjs';

export const suspendedSql = alias => `coalesce(${alias}.suspension->>'active','false')='true'`;
export function suspensionBlock(order){
 if(order?.suspension?.active===true)return 'Commande suspendue : '+order.suspension.note;
 if(order?.suspension?.erplainCancellation)return 'Annulation ERPLAIN enregistrée ou à vérifier : aucune recréation automatique autorisée';
 return null;
}
export function validateSuspension(input){
 if(typeof input?.id!=='string'||!input.id||typeof input.expectedVersion!=='string')throw Error('Commande et version requises');
 const note=typeof input.note==='string'?input.note.trim():'';
 if(!note||note.length>2000)throw Error('Saisir une note de 1 à 2000 caractères');
 return {...input,note};
}
export async function initializeOrderSuspension(db){
 await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS suspension JSONB NOT NULL DEFAULT '{}';
 CREATE TABLE IF NOT EXISTS order_suspension_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),action TEXT NOT NULL,user_email TEXT NOT NULL,note TEXT NOT NULL,state JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS order_suspension_events_order ON order_suspension_events(order_id,created_at);
 CREATE OR REPLACE FUNCTION v3_suspension_job_guard() RETURNS trigger AS $$ DECLARE v JSONB; oid TEXT; blocked BOOLEAN; BEGIN
 v=to_jsonb(NEW);
 IF TG_TABLE_NAME='temu_label_jobs' THEN SELECT bool_or(coalesce(suspension->>'active','false')='true' OR suspension ? 'erplainCancellation') INTO blocked FROM (SELECT suspension FROM orders WHERE reference=v->>'reference' FOR SHARE) locked_orders;
 ELSE oid=v->>'order_id'; SELECT coalesce(suspension->>'active','false')='true' OR suspension ? 'erplainCancellation' INTO blocked FROM orders WHERE id=oid FOR SHARE; END IF;
 IF blocked AND ((v->>'status') IN ('processing','running','applying','checking','creating','creating_bl','publishing_bl','creating_stock','finalizing_bl','creating_label','purchasing') OR (TG_TABLE_NAME='document_lifecycle' AND coalesce((v->>'locked')::boolean,false))) THEN
 RAISE EXCEPTION 'Commande suspendue ou annulation ERPLAIN à vérifier : traitement interdit'; END IF;
 RETURN NEW; END; $$ LANGUAGE plpgsql;`);
 for(const table of ['jobs','erp_live_jobs','carrier_jobs','resolution_jobs','partial_deliveries','extra_parcels','correction_jobs','temu_label_jobs','document_lifecycle']){
  if(!(await db.query('SELECT to_regclass($1) AS name',[table])).rows[0]?.name)continue;
  await db.exec(`DROP TRIGGER IF EXISTS v3_suspension_guard ON ${table}; CREATE TRIGGER v3_suspension_guard BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION v3_suspension_job_guard();`);
 }
}
const busySql=`SELECT 'Erplain' AS kind FROM erp_live_jobs WHERE order_id=$1 AND status='processing'
 UNION ALL SELECT 'transporteur' FROM carrier_jobs WHERE order_id=$1 AND status IN ('creating','awaiting_pdf')
 UNION ALL SELECT 'correction' FROM resolution_jobs WHERE order_id=$1 AND status='running'
 UNION ALL SELECT 'correction Erplain' FROM correction_jobs WHERE order_id=$1 AND status IN ('applying','checking')
 UNION ALL SELECT 'livraison partielle' FROM partial_deliveries WHERE order_id=$1 AND status IN ('creating_bl','draft_ready','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf')
 UNION ALL SELECT 'colis supplémentaire' FROM extra_parcels WHERE order_id=$1 AND status IN ('creating','awaiting_pdf')
 UNION ALL SELECT 'cycle documentaire' FROM document_lifecycle WHERE order_id=$1 AND locked=true
 UNION ALL SELECT 'traitement local' FROM jobs WHERE order_id=$1 AND status='processing'
 UNION ALL SELECT 'achat TEMU' FROM temu_label_jobs WHERE reference=$2 AND status IN ('purchasing','uncertain')`;
export async function assertOrderIdle(db,order){
 const rows=(await db.query(busySql,[order.id,order.reference])).rows;
 if(rows.length)throw Error('Attendre ou rapprocher le traitement en cours : '+[...new Set(rows.map(x=>x.kind))].join(', '));
}
const idle=assertOrderIdle;
function physicalBlock(order){
 if(['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status)||['shipped','delivered'].includes(order.erp_live?.bl?.status))throw Error('Annulation non appliquée : le BL est déjà expédié ou livré.');
}
function version(state){return state.version||'';}
async function event(tx,order,action,note,state,user){
 await tx.query('INSERT INTO order_suspension_events(id,order_id,action,user_email,note,state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),order.id,action,user.email,note,JSON.stringify(state)]);
 await tx.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,'order.'+action,JSON.stringify({orderId:order.id,note,version:state.version})]);
}
export function orderSuspensionService(db,api,{onTiming=event=>console.info(JSON.stringify({event:'order-suspension-timing',...event}))}={}){
 function recordTiming(event){try{onTiming(event);}catch{}}
 function authorized(user){if(!['admin','manager','operator'].includes(user?.role))throw Object.assign(Error('Droits insuffisants'),{status:403});}
 async function context(id,requestedTrace){
  const began=performance.now(),requestId=/^[a-f0-9-]{36}$/.test(requestedTrace||'')?requestedTrace:randomUUID();
  const order=(await db.query('SELECT id,reference,suspension,erp_live,tracking_status,archived FROM orders WHERE id=$1',[id])).rows[0];
  if(!order)throw Error('Commande introuvable');
  const history=(await db.query('SELECT action,user_email,note,state,created_at FROM order_suspension_events WHERE order_id=$1 ORDER BY created_at DESC,id DESC',[id])).rows;
  const timings={contextMs:Math.round(performance.now()-began)};recordTiming({requestId,action:'context',...timings});return {order,history,requestId,timings};
 }
 async function locked(id,fn){
  const order=(await db.query('SELECT reference FROM orders WHERE id=$1',[id])).rows[0];if(!order)throw Error('Commande introuvable');
  return withShipmentLock(fn,['stock-mutations','temu-order:'+order.reference,'suspension:'+id]);
 }
 async function change(input,user,active){
  authorized(user);const b=validateSuspension(input);
  const began=performance.now(),requestId=randomUUID();
  const transaction=db.localTransaction|| (async fn=>({result:await db.transaction(fn),timings:{totalMs:Math.round(performance.now()-began)}}));
  try{const {result,timings}=await transaction(async tx=>{
   const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE NOWAIT',[b.id])).rows[0];
   if(!order||order.archived)throw Error('Commande absente ou archivée');
   if(version(order.suspension)!==b.expectedVersion)throw Error('La commande a changé : actualiser avant de confirmer');
   if((order.suspension?.active===true)===active)throw Error(active?'Commande déjà suspendue':'Commande déjà active');
   if(!active&&['processing','review'].includes(order.suspension?.erplainCancellation?.status))throw Error('Annulation ERPLAIN à rapprocher avant réactivation');
   // Suspension is a local hold, including shipped/delivered orders.
   // Physical/document cancellation keeps its separate guard below.
   // NOWAIT avoids job-row/order-row deadlocks. Claim triggers take FOR SHARE
   // on this order; a new claim after commit will see suspension.active=true.
   for(const table of ['erp_live_jobs','carrier_jobs','resolution_jobs','correction_jobs','partial_deliveries','extra_parcels','document_lifecycle','jobs'])
    await tx.query(`SELECT order_id FROM ${table} WHERE order_id=$1 FOR UPDATE NOWAIT`,[b.id]);
   await tx.query('SELECT reference FROM temu_label_jobs WHERE reference=$1 FOR UPDATE NOWAIT',[order.reference]);
   await idle(tx,order);
   const state={...order.suspension,active,note:b.note,version:randomUUID(),updatedAt:new Date().toISOString(),updatedBy:user.email};
   if(active){state.suspendedAt=state.updatedAt;state.suspendedBy=user.email;}
   // Retain documents and errors; stop queued work. Reactivation never queues a job.
   const reason='Commande suspendue : '+b.note;
   if(active){
    await tx.query("UPDATE erp_live_jobs SET status='review',error=concat_ws(' · ',nullif(error,''),$2::text),updated_at=now() WHERE order_id=$1 AND status='pending'",[b.id,reason]);
    await tx.query("UPDATE resolution_jobs SET status='review',stage='Commande suspendue',error=concat_ws(' · ',nullif(error,''),$2::text),updated_at=now() WHERE order_id=$1 AND status IN ('queued','waiting')",[b.id,reason]);
    await tx.query("UPDATE correction_jobs SET status='review',error=concat_ws(' · ',nullif(error,''),$2::text),updated_at=now() WHERE order_id=$1 AND status IN ('queued','waiting')",[b.id,reason]);
    await tx.query("UPDATE carrier_jobs SET status='failed',error=concat_ws(' · ',nullif(error,''),$2::text),updated_at=now() WHERE order_id=$1 AND status='pending' AND result IS NULL",[b.id,reason]);
    await tx.query("UPDATE partial_deliveries SET status='review',error=concat_ws(' · ',nullif(error,''),$2::text) WHERE order_id=$1 AND status IN ('queued','bl_ready')",[b.id,reason]);
    await tx.query("UPDATE extra_parcels SET status='failed',error=concat_ws(' · ',nullif(error,''),$2::text) WHERE order_id=$1 AND status='pending' AND result IS NULL",[b.id,reason]);
    await tx.query("UPDATE jobs SET status='blocked',error=concat_ws(' · ',nullif(error,''),$2::text) WHERE order_id=$1 AND status='pending'",[b.id,reason]);
   }
   await tx.query('UPDATE orders SET suspension=$2,resolution_pending_resume=true WHERE id=$1',[b.id,JSON.stringify(state)]);
   await event(tx,order,active?'suspended':'reactivated',b.note,state,user);
   return {ok:true,message:active?'Commande suspendue.':state.erplainCancellation?'Commande réactivée dans V3. Le BC ERPLAIN annulé reste protégé contre toute recréation automatique.':'Commande réactivée. Reprise manuelle nécessaire.',suspension:state};
  });recordTiming({requestId,action:active?'suspend':'reactivate',outcome:'saved',...timings});return {...result,requestId,timings};
  }catch(error){recordTiming({requestId,action:active?'suspend':'reactivate',outcome:error.code==='LOCAL_ORDER_UNCERTAIN'?'uncertain':'refused',totalMs:Math.round(performance.now()-began),code:error.code||'business_guard',phase:error.phase||'transaction',...error.timings});if(error.code==='55P03'||error.code==='57014')throw localOrderBusy(error);throw error;}
 }
 async function saveCancelledDocuments(tx,order,state,bc){
  const documents={bc:{...order.erp_live.bc,status:bc.status}};
  const bl=order.erp_live?.bl;
  if(bl?.id&&bc.shipping_orders.data.some(item=>String(item.id)===String(bl.id)&&item.status==='cancelled'))documents.bl={...bl,status:'cancelled'};
  await tx.query('UPDATE orders SET suspension=$2,erp_live=erp_live||$3::jsonb WHERE id=$1',[order.id,JSON.stringify(state),JSON.stringify(documents)]);
 }
 async function cancelErplain(input,user){
  authorized(user);
  if(typeof input?.id!=='string'||typeof input.expectedVersion!=='string'||(input.confirm!==true&&input.verifyOnly!==true))throw Error('Confirmer explicitement l’annulation ERPLAIN');
  return locked(input.id,async()=>{
   let order=(await db.query('SELECT * FROM orders WHERE id=$1',[input.id])).rows[0];
   if(!order?.suspension?.active||order.archived)throw Error('Suspendre la commande avant d’annuler dans ERPLAIN');
   if(version(order.suspension)!==input.expectedVersion)throw Error('La commande a changé : actualiser avant de confirmer');
   if(order.suspension.erplainCancellation?.status==='complete')return {ok:true,message:'Annulation ERPLAIN déjà confirmée.'};
   physicalBlock(order);await idle(db,order);
   const bcId=String(order.erp_live?.bc?.id||'');if(!/^\d+$/.test(bcId))throw Error('Aucun BC ERPLAIN confirmé à annuler');
   await api.verify();
   const bc=await readErplainDocuments(api,bcId),gateway=erplainLifecycleGateway(api);
   const billing=(await api.request('query V3SuspensionBilling($id:ID!){Order(id:$id){id external_reference invoices_count paid_amount}}',{id:bcId})).Order;
   if(String(billing?.id)!==bcId||billing.invoices_count==null||billing.paid_amount==null||Number(billing.invoices_count)!==0||Number(billing.paid_amount)!==0)throw Error('BC facturé, payé ou contrôle incomplet : annulation refusée');
   if(![order.reference,'V3:'+order.id].includes(billing.external_reference)&&order.source_payload?.erplainImported!==true)throw Error('Identité du BC différente de la commande : annulation refusée');
   if(!['active','pending','unpublished','cancelled'].includes(bc.status))throw Error('Statut BC incompatible avec l’annulation : '+bc.status);
   if(order.suspension.erplainCancellation?.bcId&&order.suspension.erplainCancellation.bcId!==bcId)throw Error('BC différent de la précédente tentative : rapprochement requis');
   if(input.verifyOnly===true||order.suspension.erplainCancellation){
    const previous=order.suspension.erplainCancellation;
    if(previous?.bcId&&previous.bcId!==bcId)throw Error('BC différent de la tentative enregistrée : rapprochement requis');
    if(bc.status!=='cancelled'||bc.shipping_orders.data.some(b=>b.status!=='cancelled'))return {ok:true,message:'Vérification ERPLAIN : annulation non entièrement confirmée. Aucun nouvel essai effectué ; rapprochement nécessaire.'};
    const state={...order.suspension,version:randomUUID(),erplainCancellation:{...previous,bcId,bcLabel:bc.label,status:'complete',confirmedAt:new Date().toISOString()}};
    await db.transaction(async tx=>{await saveCancelledDocuments(tx,order,state,bc);await event(tx,order,'erplain_cancelled',state.note,state,user);});
    return {ok:true,message:'Annulation ERPLAIN vérifiée. La commande reste suspendue dans V3.',suspension:state};
   }
   // Read all related documents before the first write; never cancel another order's BL.
   const bls=[];
   for(const item of bc.shipping_orders.data){
    const raw=(await api.request('query V3SuspensionBLGuard($id:ID!){ShippingOrder(id:$id){id status invoices_count orders(first:100){data{id status} paginatorInfo{hasMorePages}} invoices(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:String(item.id)})).ShippingOrder;
    if(String(raw?.id)!==String(item.id)||raw.orders?.paginatorInfo?.hasMorePages!==false||raw.invoices?.paginatorInfo?.hasMorePages!==false||raw.invoices_count==null)throw Error('BL ou documents liés incomplets : annulation refusée');
    const bl={...raw,invoicesCount:Number(raw.invoices_count),invoices:raw.invoices.data};
    if(['shipped','delivered'].includes(bl.status))throw Error('Annulation non appliquée : le BL est déjà expédié ou livré.');
    if(!['unpublished','pending','make_the_shipment','in_preparation','ready_to_ship','cancelled'].includes(bl.status))throw Error('BL de statut inconnu : annulation refusée');
    if(!Array.isArray(bl.orders?.data)||bl.orders.data.length!==1||String(bl.orders.data[0].id)!==bcId)throw Error('BL partagé ou association BC incertaine : annulation refusée');
    if(!Number.isInteger(bl.invoicesCount)||bl.invoicesCount!==0||!Array.isArray(bl.invoices)||bl.invoices.length)throw Error('BL facturé ou facturation non vérifiable : annulation refusée');
    bls.push(bl);
   }
   // Separate stock movements need the existing explicit reconciliation workflow.
   const stockHeld=order.erp_live?.stockDocument?.id||order.erp_live?.documentSource?.stockHolds?.length||order.erp_live?.partialSource?.stockHolds?.length||(await db.query("SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND stock_document->>'id' IS NOT NULL",[order.id])).rows.length;
   if(stockHeld||bc.shipping_orders.data.some(b=>b.update_stock!==false))throw Error('Mouvement de stock associé au BL : rapprocher le stock avant annulation ERPLAIN');
   const state={...order.suspension,version:randomUUID(),erplainCancellation:{status:'processing',bcId,bcLabel:bc.label,blIds:bls.map(b=>String(b.id)),startedAt:new Date().toISOString(),user:user.email}};
   await db.transaction(async tx=>{const current=(await tx.query('SELECT suspension FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(version(current.suspension)!==input.expectedVersion)throw Error('La commande a changé');await tx.query('UPDATE orders SET suspension=$2 WHERE id=$1',[order.id,JSON.stringify(state)]);await event(tx,order,'erplain_cancellation_started',state.note,state,user);});
   try{
    for(const bl of bls)if(bl.status!=='cancelled')await gateway.setBLStatus(bl.id,'cancelled');
    if(bc.status!=='cancelled')await gateway.cancelOrder(bcId);
    const verified=await readErplainDocuments(api,bcId);
    if(verified.status!=='cancelled'||verified.shipping_orders.data.some(b=>b.status!=='cancelled'))throw Error('Annulation ERPLAIN non entièrement confirmée : rapprochement requis');
    state.version=randomUUID();state.erplainCancellation={...state.erplainCancellation,status:'complete',confirmedAt:new Date().toISOString()};
    await db.transaction(async tx=>{await saveCancelledDocuments(tx,order,state,verified);await event(tx,order,'erplain_cancelled',state.note,state,user);});
    return {ok:true,message:'Annulation ERPLAIN confirmée. La commande reste suspendue dans V3, en attente du client.',suspension:state};
   }catch(error){
    state.version=randomUUID();state.erplainCancellation={...state.erplainCancellation,status:'review',error:String(error.message).slice(0,1000)};
    await db.transaction(async tx=>{await tx.query('UPDATE orders SET suspension=$2 WHERE id=$1',[order.id,JSON.stringify(state)]);await event(tx,order,'erplain_cancellation_review',state.note,state,user);});
    throw Error('Annulation ERPLAIN à vérifier. Aucun nouvel essai automatique. '+error.message);
   }
  });
 }
 return {context,suspend:(b,u)=>change(b,u,true),reactivate:(b,u)=>change(b,u,false),cancelErplain};
}
