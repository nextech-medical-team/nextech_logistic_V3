import {recoveryScope,scopeSnapshot} from './erplain-pending-scope.mjs';
import {completeShippingOrders} from './erplain-document-read.mjs';
import {assertDocumentRead,documentIssues,existingBcOrder,initializeTargetedOrders} from './erplain-targeted-orders.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {manualImportIssue,manualOrderFields} from './manual-erplain-orders.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function manualReviewHash(d){return createHash('sha256').update(JSON.stringify(canonical(d))).digest('hex');}
export function assertManualReview(d){const issue=manualImportIssue(d);if(issue)throw Error(issue);for(const l of recoveryScope(d).lines)if(l.variant?.active===false||l.variant?.product?.active===false)throw Error(l.variant?.sku+' · Produit inactif dans Erplain LIVE');}
export async function queueManualReview(db,d,orderId=null){await db.query("INSERT INTO erplain_manual_review(bc_id,document,review_hash,order_id) VALUES($1,$2,$3,$4) ON CONFLICT(bc_id) DO UPDATE SET document=excluded.document,review_hash=excluded.review_hash,updated_at=now() WHERE erplain_manual_review.status='pending'",[String(d.id),JSON.stringify(d),manualReviewHash(d),orderId]);}
export async function initializeManualReview(db){await db.exec("CREATE TABLE IF NOT EXISTS erplain_manual_review(bc_id TEXT PRIMARY KEY,document JSONB NOT NULL,review_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',order_id TEXT REFERENCES orders(id),reason TEXT,validated_by TEXT,validated_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());");
 await initializeTargetedOrders(db);
 const old=(await db.query("SELECT o.* FROM orders o WHERE o.source_payload->>'erplainImported'='true' AND o.source_payload->>'account'='live' AND NOT o.archived AND o.erp_live->'bl'->>'id' IS NULL AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND (c.result IS NOT NULL OR c.tracking<>'[]'::jsonb OR c.status IN ('pending','creating','awaiting_pdf','ready'))) AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status IN ('pending','processing')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting')) AND NOT EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.order_id=o.id AND p.status<>'cancelled') AND coalesce(o.source_payload->>'erplainValidation','') NOT IN ('approved','rejected')")).rows;
 for(const o of old){if(!o.erp_live?.bc?.id||(o.erp_live.bc.shipping_orders?.data||[]).some(s=>s.status!=='cancelled'))continue;await db.transaction(async tx=>{await queueManualReview(tx,o.erp_live.bc,o.id);await tx.query("UPDATE orders SET archived=true,resolution_pending_resume=true,source_payload=source_payload||'{\"erplainValidation\":\"pending\",\"erplainValidationHold\":true}'::jsonb WHERE id=$1",[o.id]);});}
}
export function manualReviewService(db,api){return {
 async list(){return {rows:(await db.query("SELECT *, EXISTS(SELECT 1 FROM orders o WHERE NOT o.archived AND o.reference=coalesce(document->>'external_reference',document->>'label') AND o.id IS DISTINCT FROM r.order_id) AS duplicate FROM erplain_manual_review r ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 500")).rows};},
 async approve(b,user){
  if(b.confirmed!==true||typeof b.bcId!=='string'||!b.bcId.trim()||typeof b.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(b.reviewHash))throw Error('Contrôle manuel et confirmation requis');
  return withShipmentLock(()=>db.transaction(async tx=>{
   const r=(await tx.query('SELECT * FROM erplain_manual_review WHERE bc_id=$1 FOR UPDATE',[b.bcId])).rows[0];
   if(!r)throw Error('BC en attente introuvable');
   const existing=await existingBcOrder(tx,b.bcId);
   if(r.status==='approved'||existing&&existing.id!==r.order_id||existing&&existing.source_payload?.erplainValidation==='approved'){
    if(!existing)throw Error('Identité de la commande validée à rapprocher');
    return {orderId:existing.id,alreadyRecovered:true,replayed:true,archived:existing.archived};
   }
   if(r.status!=='pending')throw Error('BC déjà refusé ou en annulation');
   if(r.review_hash!==b.reviewHash)throw Error('Validation périmée : relire le BC');
   await api.verify();const {Order:d}=await api.request(`query V3ManualValidate($id:ID!){Order(id:$id){${manualOrderFields}}}`,{id:b.bcId});
   if(d&&String(d.id)===b.bcId)await completeShippingOrders(api,d);
   assertDocumentRead(d,b.bcId);
   await tx.query("UPDATE erplain_refresh_cache SET detail=$2,reference=$3,seen_at=now(),missing=false WHERE account='live' AND section='orders' AND entity_id=$1",[b.bcId,JSON.stringify(d),d.external_reference||d.label]);
   if(manualReviewHash(d)!==b.reviewHash){await queueManualReview(tx,d,r.order_id);return {changed:true,previousDocument:r.document,document:d,reviewHash:manualReviewHash(d),...documentIssues(d),readAt:new Date().toISOString()};}
   const scope=recoveryScope(d);const issues=documentIssues(d);if(issues.admissionIssues.length)throw Error(issues.admissionIssues.join(' ; '));
   const ref=String(d.external_reference||d.label).trim();
   if(db.kind==='postgres')await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('nextech:import-order-identity',0))");
   // Excluded tender documents keep the installed duplicate-validation contract.
   const tender=existing?.channel==='tender'||d.account_representative?.label==="Appels d'offres";
   const duplicates=(await (tender
    ?tx.query('SELECT id FROM orders WHERE reference=$1 AND id IS DISTINCT FROM $2',[ref,r.order_id])
    :tx.query("SELECT id FROM orders WHERE (reference=$1 OR coalesce(source_reference,reference)=$1 OR erp_live->'bc'->>'id'=$3) AND id IS DISTINCT FROM $2",[ref,r.order_id,b.bcId]))).rows;
   if(duplicates.length)throw Error('Référence déjà présente dans V3 : rapprochement requis, aucune seconde commande créée');
   let id=r.order_id;
   if(id){
    const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!o||String(o.erp_live?.bc?.id)!==b.bcId||o.source_payload?.account!=='live')throw Error('Identité Erplain de la commande à rapprocher');
    if(o.erp_live.bc.status==='cancelled')throw Error('Commande annulée : réactivation interdite');
    const local=(await tx.query('SELECT * FROM lines WHERE order_id=$1',[id])).rows;
    const totals=ls=>JSON.stringify(ls.map(l=>[l.variant?.sku||l.target_sku,Number(l.variant?l.quantity:l.target_quantity)]).sort());
    if(totals(local)!==totals(scope.lines))throw Error('Produits ou quantités de la commande existante différents : rapprochement requis');
    await tx.query("UPDATE orders SET erp_live=erp_live||$2::jsonb,archived=false,resolution_pending_resume=true,source_payload=source_payload||$3::jsonb WHERE id=$1",[id,JSON.stringify({bc:scopeSnapshot(d,scope),customer:d.customer,pendingBlIds:scope.pending.map(b=>String(b.id)),...(scope.pending.length===1?{bl:scope.pending[0]}:{})}),JSON.stringify({erplainValidation:'approved',erplainValidationHold:false,erplainValidatedBy:user.email,erplainValidatedAt:new Date().toISOString()})]);
   }else{
    id=randomUUID();const recipient=d.customer.label,a=d.shipping_address||{};
    await tx.query("INSERT INTO orders(id,channel,reference,recipient,address,source_date,erp_live,source_payload,label_status,erp_status,resolution_pending_resume,issue) VALUES($1,'erplain',$2,$3,$4,$5,$6,$7,'blocked','live_review',true,'Commande Erplain validée : choisir le circuit de préparation')",[id,ref,recipient,JSON.stringify({name:a.label||recipient,street:[a.address_1,a.address_2].filter(Boolean).join(' '),postal:a.postal_code||'',city:a.city||'',country:a.country||'',phone:a.phone||'',email:''}),d.dated_at,JSON.stringify({bc:scopeSnapshot(d,scope),customer:d.customer,pendingBlIds:scope.pending.map(b=>String(b.id)),...(scope.pending.length===1?{bl:scope.pending[0]}:{})}),JSON.stringify({erplainImported:true,account:'live',currency:d.currency.label,erplainValidation:'approved',erplainValidatedBy:user.email,erplainValidatedAt:new Date().toISOString()})]);
    for(const l of scope.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,target_sku,target_quantity,source_payload) VALUES($1,$2,$3,$4,$5,$4,$5,$6)',[randomUUID(),id,String(l.id),l.variant.sku,l.quantity,JSON.stringify({erplainVariantId:l.variant.id,unitsAlreadyConverted:true,puht:l.price})]);
   }
   await tx.query("INSERT INTO erplain_order_identity(account,bc_id,order_id) VALUES('live',$1,$2) ON CONFLICT(account,bc_id) DO NOTHING",[b.bcId,id]);
   const identity=(await tx.query("SELECT order_id FROM erplain_order_identity WHERE account='live' AND bc_id=$1",[b.bcId])).rows[0];
   if(identity.order_id!==id)throw Error('BC déjà admis : rapprochement requis');
   await tx.query("UPDATE erplain_manual_review SET status='approved',order_id=$2,validated_by=$3,validated_at=now(),updated_at=now() WHERE bc_id=$1",[b.bcId,id,user.email]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.manual.approved',$2)",[user.email,JSON.stringify({bcId:b.bcId,orderId:id})]);
   return {orderId:id,preparationStarted:false};
  }));
 },
 async reject(b,user){
  if(typeof b.bcId!=='string'||!b.bcId||typeof b.reason!=='string'||!b.reason.trim())throw Error('Renseignez le motif du refus avant de continuer');
  const reason=b.reason.trim().slice(0,500);
  return withShipmentLock(async()=>{
   const r=(await db.query('SELECT * FROM erplain_manual_review WHERE bc_id=$1',[b.bcId])).rows[0];
   if(!r||r.status==='approved')throw Error('Commande non disponible pour refus');
   if(r.status==='rejected'&&r.document?.status==='cancelled')return {ok:true,replayed:true,bc:r.document.label};
   await api.verify();
   const read=async()=>{const x=await api.request('query V3ManualCancelCheck($id:ID!){Order(id:$id){id label status shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:b.bcId});if(!x.Order||String(x.Order.id)!==b.bcId)throw Error('BC non reçu depuis Erplain LIVE');return x.Order;};
   const before=await read();
   if(before.status!=='cancelled'){
    if(before.status!=='active')throw Error('Ce BC ne peut pas être annulé automatiquement : vérifier son statut dans Erplain LIVE');
    if(before.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(before.shipping_orders?.data))throw Error('Liste des BL non vérifiée : annulation non lancée');
    if(before.shipping_orders.data.some(x=>x.status!=='cancelled'))throw Error('Un BL existe déjà : contrôler la livraison avant de refuser cette commande');
    if(r.order_id){const busy=(await db.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (result IS NOT NULL OR tracking<>'[]'::jsonb OR status IN ('pending','creating','awaiting_pdf','ready')) UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status<>'cancelled' UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[r.order_id])).rows.length;if(busy)throw Error('Préparation engagée : annulation automatique non autorisée');}
   }
   await db.query("UPDATE erplain_manual_review SET status='cancelling',reason=$2,validated_by=$3,updated_at=now() WHERE bc_id=$1",[b.bcId,reason,user.email]);
   let after=before,problem=null;
   if(before.status!=='cancelled'){
    try{await api.request('mutation V3ManualCancel($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id status}}',{id:b.bcId,input:{status:'cancelled'}});}catch(e){problem=e.message;}
    try{after=await read();}catch(e){problem=e.message;after=null;}
   }
   if(after?.status!=='cancelled'){
    await db.query("UPDATE erplain_manual_review SET status='cancel_review',updated_at=now() WHERE bc_id=$1",[b.bcId]);
    throw Error('Annulation Erplain LIVE non confirmée. La commande reste bloquée. Cliquez sur Réessayer pour vérifier son statut avant toute nouvelle tentative.'+(problem?' '+problem:''));
   }
   await db.transaction(async tx=>{
    const document={...r.document,status:'cancelled'};
    await tx.query("UPDATE erplain_manual_review SET status='rejected',document=$2,reason=$3,validated_by=$4,validated_at=now(),updated_at=now() WHERE bc_id=$1",[b.bcId,JSON.stringify(document),reason,user.email]);
    if(r.order_id)await tx.query("UPDATE orders SET archived=true,resolution_pending_resume=true,erp_live=jsonb_set(erp_live,'{bc,status}','\"cancelled\"'::jsonb),source_payload=source_payload||'{\"erplainValidation\":\"rejected\",\"erplainValidationHold\":true}'::jsonb WHERE id=$1",[r.order_id]);
    await tx.query("UPDATE erplain_refresh_cache SET detail=jsonb_set(detail,'{status}','\"cancelled\"'::jsonb) WHERE account='live' AND section='orders' AND entity_id=$1",[b.bcId]);
    await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.manual.rejected',$2)",[user.email,JSON.stringify({bcId:b.bcId,reason,erplainStatus:'cancelled',account:'live'})]);
   });
   return {ok:true,bc:after.label,erplainStatus:'cancelled'};
  });
 }

};}
