import {usesRecordedBc} from './existing-bc-execution.mjs';
import {createHash} from 'node:crypto';
import {readErplainDocuments} from './erplain-document-read.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';

export const preparationChangedError='Préparation modifiée depuis la validation du BL : recontrôler les quantités et le transport avant étiquette.';
export const preparationRevalidatedMessage='Échec d’étiquette antérieur, suivi d’une revalidation BC/BL. Aucune relance effectuée.';
const fail=reason=>({verified:false,reason});
const id=v=>(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)||(typeof v==='string'&&/^[1-9]\d*$/.test(v));
const units=v=>{
 if(!['number','string'].includes(typeof v)||!Number.isFinite(Number(v))||Number(v)<=0)return null;
 const m=String(v).match(/^(\d+)(?:\.(\d+))?$/);if(!m)return null;
 const fraction=(m[2]||'').replace(/0+$/,'');if(fraction.length>6)return null;
 const n=BigInt(m[1]+fraction.padEnd(6,'0'));return n>0n&&n<=BigInt(Number.MAX_SAFE_INTEGER)?n:null;
};
const qty=v=>units(v)!==null;
const time=v=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const fingerprint=(o,lines)=>createHash('sha256').update(JSON.stringify({id:o.id,address:o.address,weight:o.weight_kg,lines:usesRecordedBc(o)?{authority:"recorded_bc",bcId:String(o.erp_live.bc.id)}:lines.map(l=>({source_sku:l.source_sku,target_sku:l.target_sku,quantity:l.quantity,target_quantity:l.target_quantity}))})).digest('hex');

// This proof concerns only the superseded preparation-fingerprint rejection.
// It is never permission to create a shipment, resume an order or debit stock.
export function carrierPrevalidationProof(o,c,e,lines,bc,{now=Date.now()}={}){
 if(!o?.id||c?.status!=='failed'||c.error!==preparationChangedError||c.environment!=='production'||c.result!==null||!Array.isArray(c.tracking)||c.tracking.length||c.document_count!==0||c.stock_override!==null)return fail('not_definite_preflight_failure');
 if(o.archived||o.partial_mode||o.suspension?.active||o.suspension?.erplainCancellation||o.source_payload?.marketplacePendingCorrection||!['not_shipped','unknown'].includes(o.tracking_status))return fail('protected_order');
 if(o.source_payload?.erplainValidationHold&&o.source_payload.erplainValidation!=='approved')return fail('validation_hold');
 if(['ready','production_ready','sandbox_ready','cancelled'].includes(o.label_status))return fail('label_state_changed');
 const s=o.erp_live||{},verified=time(s.verifiedAt),failedAt=time(c.updated_at),erpAt=time(e?.updated_at),stockAt=time(s.stockCheckedAt);
 if(e?.status!=='complete'||e.error!==null||s.phase!=='bl_ready'||!Number.isFinite(verified)||!Number.isFinite(failedAt)||!Number.isFinite(erpAt)||!Number.isFinite(stockAt)||verified<=failedAt||erpAt<verified||Math.max(verified,erpAt,stockAt)>now+5000)return fail('no_later_validation');
 if(!id(s.bc?.id)||s.bc.status!=='active'||!id(s.bl?.id)||s.bl.status!=='ready_to_ship')return fail('local_documents_not_ready');
 if(!usesRecordedBc(o)&&(!Array.isArray(lines)||!lines.length||lines.some(l=>typeof l.target_sku!=='string'||!l.target_sku.trim()||!qty(l.target_quantity))))return fail('local_lines_unconfirmed');
 const currentFingerprint=fingerprint(o,lines);
 if(!usesRecordedBc(o)&&(!/^[a-f0-9]{64}$/.test(s.labelPreparationFingerprint||'')||currentFingerprint!==s.labelPreparationFingerprint))return fail('current_preparation_changed');
 if(!id(bc?.id)||String(bc.id)!==String(s.bc.id)||bc.status!=='active'||!Array.isArray(bc.line_items))return fail('provider_bc_unconfirmed');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)return fail('provider_history_incomplete');
 const seen=new Set();for(const bl of bc.shipping_orders.data){if(!id(bl.id)||seen.has(String(bl.id)))return fail('provider_history_ambiguous');seen.add(String(bl.id));}
 const selected=bc.shipping_orders.data.find(b=>String(b.id)===String(s.bl.id));
 if(selected?.status!=='ready_to_ship'||!Array.isArray(selected.line_items))return fail('provider_bl_not_ready');
 const local=new Map(),actual=new Map(),identities=new Map(),parents=new Set(),proofLines=[];
 if(!usesRecordedBc(o))for(const l of lines)local.set(l.target_sku,(local.get(l.target_sku)||0n)+units(l.target_quantity));
 for(const l of selected.line_items){
  if(l.type==='shipping_cost')continue;
  if(l.type!=='normal'||!id(l.parent_id)||parents.has(String(l.parent_id))||!id(l.variant?.id)||typeof l.variant.sku!=='string'||!l.variant.sku.trim()||!id(l.location?.id)||!qty(l.quantity))return fail('provider_bl_lines_invalid');
  parents.add(String(l.parent_id));const matches=bc.line_items.filter(p=>String(p.id)===String(l.parent_id));
  const p=matches[0];if(matches.length!==1||p.type!=='normal'||!qty(p.quantity)||units(l.quantity)>units(p.quantity)||String(p.variant?.id)!==String(l.variant.id)||p.variant?.sku!==l.variant.sku||String(p.location?.id)!==String(l.location.id))return fail('provider_parent_unconfirmed');
  const identity=String(l.variant.id)+':'+String(l.location.id),sku=l.variant.sku;
  if(identities.has(sku)&&identities.get(sku)!==identity)return fail('provider_sku_ambiguous');identities.set(sku,identity);
  actual.set(sku,(actual.get(sku)||0n)+units(l.quantity));proofLines.push({parentId:String(l.parent_id),variantId:String(l.variant.id),locationId:String(l.location.id),sku,quantity:Number(l.quantity)});
 }
 if(!actual.size||(!usesRecordedBc(o)&&(local.size!==actual.size||[...local].some(([sku,q])=>q!==actual.get(sku)))))return fail('current_quantities_differ');
 return {verified:true,bcId:String(bc.id),blId:String(selected.id),blStatus:selected.status,validationAt:new Date(verified).toISOString(),previousFailureAt:new Date(failedAt).toISOString(),fingerprint:currentFingerprint,lines:proofLines,readOnly:true,businessActionAuthorized:false};
}

const context=(o,c,e,lines)=>JSON.stringify({order:o,carrier:c,erp:e,lines});
const carrierSql="SELECT c.*, (SELECT count(*)::int FROM carrier_documents d WHERE d.order_id=c.order_id) AS document_count FROM carrier_jobs c WHERE c.order_id=$1";
export function carrierPrevalidationReconciler(db,api,{now=()=>Date.now()}={}){
 let nextAt=0,lastId='';
 return {async run(){
  if(now()<nextAt)return {throttled:true};nextAt=now()+60000;
  const selector=`SELECT c.order_id FROM carrier_jobs c JOIN orders o ON o.id=c.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE c.status='failed' AND c.error=$1 AND c.environment='production' AND c.result IS NULL AND c.tracking='[]'::jsonb AND c.stock_override IS NULL
   AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=c.order_id)
   AND NOT coalesce(o.archived,false) AND NOT coalesce(o.partial_mode,false)
   AND coalesce(o.suspension->>'active','false')<>'true' AND NOT coalesce(o.suspension ? 'erplainCancellation',false)
   AND e.status='complete' AND e.error IS NULL AND o.erp_live->>'phase'='bl_ready'
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND c.order_id>$2 ORDER BY c.order_id LIMIT 1`;
  let candidate=(await db.query(selector,[preparationChangedError,lastId])).rows[0];
  if(!candidate&&lastId){lastId='';candidate=(await db.query(selector,[preparationChangedError,lastId])).rows[0];}
  if(!candidate)return {checked:0};lastId=candidate.order_id;
  const order=(await db.query('SELECT * FROM orders WHERE id=$1',[lastId])).rows[0];
  const carrier=(await db.query(carrierSql,[lastId])).rows[0];
  const erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1',[lastId])).rows[0];
  const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[lastId])).rows;
  const before=context(order,carrier,erp,lines);
  const preflight=carrierPrevalidationProof(order,carrier,erp,lines,null,{now:now()});
  if(preflight.reason!=='provider_bc_unconfirmed')return {checked:1,changed:0,reason:preflight.reason};
  let proof,calls=0;
  try{
   await api.verify();
   const reader={request:(query,variables)=>{if(!/^query\s/.test(query)||++calls>5)throw Error('Read-only diagnostic budget');return api.request(query,variables);}};
   const bc=await readErplainDocuments(reader,order.erp_live.bc.id);proof=carrierPrevalidationProof(order,carrier,erp,lines,bc,{now:now()});
  }catch{return {checked:1,changed:0,reason:'provider_read_unconfirmed'};}
  if(!proof.verified)return {checked:1,changed:0,reason:proof.reason};
  return db.transaction(async tx=>{
   const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
   const freshCarrier=(await tx.query(carrierSql+' FOR UPDATE OF c',[order.id])).rows[0];
   const freshErp=(await tx.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[order.id])).rows[0];
   const freshLines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id FOR SHARE',[order.id])).rows;
   if(context(fresh,freshCarrier,freshErp,freshLines)!==before)return {checked:1,changed:0,deferred:'local_state_changed'};
   if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status IN ('creating_bl','publishing_bl','creating_stock','finalizing_bl','creating_label','awaiting_pdf')",[order.id])).rows.length)return {checked:1,changed:0,deferred:'processing'};
   // Reuse the installed label gate with no stock override, entirely query-only.
   try{await assertLabelStockGate(tx,fresh);}catch{return {checked:1,changed:0,reason:'label_gate_unconfirmed'};}
   const audit={orderId:order.id,previousError:carrier.error,previousUpdatedAt:carrier.updated_at,previousStateSince:carrier.state_since??null,currentError:preparationRevalidatedMessage,checkedAt:new Date(now()).toISOString(),proof,providerQueries:calls,labelPurchased:false,businessWrites:0};
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','carrier.prevalidation_diagnostic_revalidated',$1)",[JSON.stringify(audit)]);
   const changed=await tx.query("UPDATE carrier_jobs SET error=$2,updated_at=now() WHERE order_id=$1 AND status='failed' AND error=$3 AND result IS NULL AND tracking='[]'::jsonb AND stock_override IS NULL RETURNING order_id",[order.id,preparationRevalidatedMessage,preparationChangedError]);
   if(changed.rows.length!==1)throw Error('Diagnostic changed concurrently; audit must roll back');
   return {checked:1,changed:1,reason:'preparation_revalidated',businessWrites:0};
  });
 }};
}
