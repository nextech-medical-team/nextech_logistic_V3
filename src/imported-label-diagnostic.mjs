import {isImportedErplain,resolveImportedLabelOrder} from './erplain-label-required.mjs';
import {assertLabelStockGate,shipmentFingerprint} from './label-stock-gate.mjs';

export const missingFieldsPrefix='Erplain LIVE · Informations obligatoires manquantes : ';
export const importedFieldsRevalidatedMessage='Échec d’étiquette antérieur : champs Erplain relus et validés. Aucune relance effectuée.';
const fieldNames=['Client','Adresse de livraison – Nom','Adresse de livraison – Adresse 1','Adresse de livraison – Code postal','Numéro de téléphone','Référence externe','BL Erplain','Adresse de livraison – Ville','Adresse de livraison – Pays'];
export const importedFieldErrors=[
 'Erplain LIVE · Numéro de téléphone invalide : corriger avant création de l’étiquette',
 'Erplain LIVE · Pays ou code postal invalide',
 'Appels d’offres · GLS Pharma obligatoire : actualiser la préparation selon les règles transporteurs'
];
export function knownImportedFieldError(message){
 if(importedFieldErrors.includes(message))return true;
 if(typeof message!=='string'||!message.startsWith(missingFieldsPrefix))return false;
 const fields=message.slice(missingFieldsPrefix.length).split(', ');
 return fields.length>0&&new Set(fields).size===fields.length&&fields.every(f=>fieldNames.includes(f));
}
const time=v=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
export function importedDiagnosticEligibility(o,c,e,{now=Date.now()}={}){
 if(!o?.id||!isImportedErplain(o)||c?.status!=='failed'||!knownImportedFieldError(c.error)||c.environment!=='production'||c.result!==null||!Array.isArray(c.tracking)||c.tracking.length||c.document_count!==0||c.stock_override!==null)return false;
 if(o.archived||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||o.source_payload?.marketplacePendingCorrection||o.source_payload?.cancelled||o.source_payload?.cancelled_at||!['not_shipped','unknown'].includes(o.tracking_status))return false;
 if(o.source_payload?.erplainValidationHold&&o.source_payload.erplainValidation!=='approved')return false;
 if(['ready','production_ready','sandbox_ready','cancelled'].includes(o.label_status))return false;
 const s=o.erp_live||{};
 if(e?.status!=='complete'||e.error!==null||s.phase!=='bl_ready'||s.bc?.status!=='active'||s.bl?.status!=='ready_to_ship'||!s.bc?.id||!s.bl?.id)return false;
 // Field corrections do not require the ERP preparation date to follow the old failure.
 // Amazon missing-name/phone failures can postdate an otherwise valid preparation.
 for(const value of [c.updated_at,e.updated_at,s.verifiedAt,s.stockCheckedAt])if(!Number.isFinite(time(value))||time(value)>now+5000)return false;
 return /^[a-f0-9]{64}$/.test(s.labelPreparationFingerprint||'');
}
const context=(o,c,e,lines)=>JSON.stringify({order:o,carrier:c,erp:e,lines});
const carrierSql='SELECT c.*, (SELECT count(*)::int FROM carrier_documents d WHERE d.order_id=c.order_id) AS document_count FROM carrier_jobs c WHERE c.order_id=$1';

// Diagnostic-only reconciliation. Never persist the returned order/address projection,
// resume a job, create a shipment or call a provider mutation.
export function importedLabelDiagnosticReconciler(db,api,{now=()=>Date.now()}={}){
 let nextAt=0,lastId='';
 return {async run(){
  if(now()<nextAt)return {throttled:true};nextAt=now()+60000;
  const selector=`SELECT c.order_id FROM carrier_jobs c JOIN orders o ON o.id=c.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE c.status='failed' AND (c.error LIKE $1 OR c.error=ANY($3::text[])) AND c.environment='production' AND c.result IS NULL AND c.tracking='[]'::jsonb AND c.stock_override IS NULL
   AND o.source_payload->>'erplainImported'='true' AND o.source_payload->>'account'='live'
   AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=c.order_id)
   AND NOT coalesce(o.archived,false) AND NOT coalesce(o.partial_mode,false)
   AND coalesce(o.suspension->>'active','false')<>'true' AND NOT coalesce(o.suspension ? 'erplainCancellation',false)
   AND e.status='complete' AND e.error IS NULL AND o.erp_live->>'phase'='bl_ready'
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND c.order_id>$2 ORDER BY c.order_id LIMIT 1`;
  const params=()=>[missingFieldsPrefix+'%',lastId,importedFieldErrors];
  let candidate=(await db.query(selector,params())).rows[0];if(!candidate&&lastId){lastId='';candidate=(await db.query(selector,params())).rows[0];}
  if(!candidate)return {checked:0};lastId=candidate.order_id;
  const order=(await db.query('SELECT * FROM orders WHERE id=$1',[lastId])).rows[0],carrier=(await db.query(carrierSql,[lastId])).rows[0],erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1',[lastId])).rows[0],lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[lastId])).rows;
  if(!importedDiagnosticEligibility(order,carrier,erp,{now:now()}))return {checked:1,changed:0,reason:'protected_or_unconfirmed'};
  const before=context(order,carrier,erp,lines);let calls=0,response,currentError,validated=false;const started=now();
  try{await assertLabelStockGate(db,order);}catch{return {checked:1,changed:0,reason:'label_gate_unconfirmed'};}
  const reader={verify:()=>api.verify(),request:async(query,variables)=>{if(!/^query V3ImportedLabelFields\(/.test(query)||++calls>1)throw Error('Read-only imported diagnostic budget');response=await api.request(query,variables);return response;}};
  try{await resolveImportedLabelOrder(order,reader);validated=true;currentError=importedFieldsRevalidatedMessage;}
  catch(error){if(!knownImportedFieldError(error?.message))return {checked:1,changed:0,reason:'provider_validation_unconfirmed'};currentError=error.message;}
  // Independently require the response identity and complete association even when
  // a connector exception happens to carry a familiar business-error string.
  const bc=response?.Order,bl=response?.ShippingOrder,bcId=String(order.erp_live.bc.id),blId=String(order.label_bl_id||order.erp_live.bl.id);
  if(String(bc?.id)!==bcId||String(bl?.id)!==blId||bl.orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(bl.orders?.data)||!bl.orders.data.some(x=>String(x.id)===bcId)||!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status))return {checked:1,changed:0,reason:'provider_association_unconfirmed'};
  if(currentError===carrier.error)return {checked:1,changed:0,reason:'current_diagnostic_confirmed'};
  if(now()-started>120000||now()<started)return {checked:1,changed:0,reason:'provider_read_expired'};
  return db.transaction(async tx=>{
   const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0],freshCarrier=(await tx.query(carrierSql+' FOR UPDATE OF c',[order.id])).rows[0],freshErp=(await tx.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[order.id])).rows[0],freshLines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id FOR SHARE',[order.id])).rows;
   if(context(fresh,freshCarrier,freshErp,freshLines)!==before)return {checked:1,changed:0,deferred:'local_state_changed'};
   if(now()-started>120000||now()<started)return {checked:1,changed:0,reason:'provider_read_expired'};
   if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status IN ('creating_bl','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf')",[order.id])).rows.length)return {checked:1,changed:0,deferred:'processing'};
   try{await assertLabelStockGate(tx,fresh);}catch{return {checked:1,changed:0,reason:'label_gate_unconfirmed'};}
   const proof={bcId,blId,blStatus:bl.status,associationComplete:true,fieldsValidated:validated,checkedAt:new Date(now()).toISOString(),fingerprint:await shipmentFingerprint(tx,fresh),readOnly:true,businessActionAuthorized:false};
   const audit={orderId:order.id,previousError:carrier.error,previousUpdatedAt:carrier.updated_at,previousStateSince:carrier.state_since??null,currentError,proof,providerQueries:calls,labelPurchased:false,orderProjectionPersisted:false,businessWrites:0};
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','carrier.imported_fields_diagnostic_revalidated',$1)",[JSON.stringify(audit)]);
   const changed=await tx.query("UPDATE carrier_jobs SET error=$2,updated_at=now() WHERE order_id=$1 AND status='failed' AND error=$3 AND result IS NULL AND tracking='[]'::jsonb AND stock_override IS NULL RETURNING order_id",[order.id,currentError,carrier.error]);
   if(changed.rows.length!==1)throw Error('Diagnostic changed concurrently; audit must roll back');
   return {checked:1,changed:1,reason:validated?'imported_fields_revalidated':'imported_fields_diagnostic_updated',businessWrites:0};
  });
 }};
}
