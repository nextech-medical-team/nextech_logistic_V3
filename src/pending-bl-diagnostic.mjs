import {recoveredPendingScope} from './erplain-pending-scope.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';

export const noPendingBlError='Aucun BL en attente : les quantités déjà expédiées ou livrées ne sont pas récupérées';
const id=value=>(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)||(typeof value==='string'&&/^[1-9]\d*$/.test(value));
const quantity=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value))&&Number(value)>0;
const openStatuses=['pending','make_the_shipment','in_preparation','ready_to_ship'];
const fail=reason=>({verified:false,reason});
export function pendingBlDiagnosticProof(order,bc,local){
 const state=order?.erp_live||{};
 if(order?.source_payload?.erplainImported!==true||order.source_payload.account!=='live')return fail('not_live_import');
 if(order.archived||order.partial_mode||order.suspension?.active||order.suspension?.erplainCancellation||order.source_payload.marketplacePendingCorrection||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))return fail('protected_order');
 if(order.source_payload.erplainValidationHold&&order.source_payload.erplainValidation!=='approved')return fail('validation_hold');
 if(!id(state.bc?.id)||!id(state.bl?.id)||!id(bc?.id)||String(bc.id)!==String(state.bc.id)||bc.status!=='active'||state.bc.status!=='active')return fail('bc_not_confirmed');
 if(!openStatuses.includes(state.bl.status)||!Array.isArray(state.pendingBlIds)||state.pendingBlIds.length!==1||String(state.pendingBlIds[0])!==String(state.bl.id))return fail('selection_not_confirmed');
 if(!Array.isArray(bc.line_items)||!Array.isArray(local)||!local.length)return fail('lines_incomplete');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)return fail('shipping_history_incomplete');
 const allBlIds=new Set();
 for(const bl of bc.shipping_orders.data){
  if(!id(bl.id)||allBlIds.has(String(bl.id))||![...openStatuses,'shipped','delivered','completed','cancelled','unpublished'].includes(bl.status))return fail('shipping_history_invalid');allBlIds.add(String(bl.id));
  if(['cancelled','unpublished'].includes(bl.status))continue;
  if(!Array.isArray(bl.line_items))return fail('shipping_lines_incomplete');
  for(const line of bl.line_items){
   if(line.type==='shipping_cost')continue;
   if(line.type!=='normal'||!quantity(line.quantity)||!id(line.variant?.id)||!id(line.parent_id)||!id(line.location?.id))return fail('shipping_lines_invalid');
   const parent=bc.line_items.filter(item=>String(item.id)===String(line.parent_id));
   if(parent.length!==1||String(parent[0].variant?.id)!==String(line.variant.id)||String(parent[0].location?.id)!==String(line.location.id))return fail('shipping_parent_not_confirmed');
  }
 }
 for(const line of bc.line_items){if(line.type==='shipping_cost')continue;if(line.type!=='normal'||!quantity(line.quantity)||!id(line.id)||!id(line.variant?.id)||!id(line.location?.id))return fail('provider_lines_invalid');}
 let scope;try{scope=recoveredPendingScope(bc,order);}catch{return fail('pending_scope_not_confirmed');}
 if(!scope.scoped||scope.pending.length!==1||String(scope.pending[0].id)!==String(state.bl.id))return fail('selected_bl_not_confirmed');
 const actual=new Map(),expected=new Map();
 for(const line of scope.lines){
  if(line.type!=='normal'||!id(line.id)||!id(line.variant?.id)||!id(line.location?.id)||typeof line.variant.sku!=='string'||!line.variant.sku.trim()||!quantity(line.quantity))return fail('provider_lines_invalid');
  const key=String(line.id)+':'+String(line.variant.id)+':'+line.variant.sku;
  if(actual.has(key))return fail('provider_lines_ambiguous');actual.set(key,Number(line.quantity));
 }
 for(const line of local){
  if(!id(line.source_line)||!id(line.source_payload?.erplainVariantId)||typeof line.target_sku!=='string'||!line.target_sku.trim()||!quantity(line.target_quantity))return fail('local_lines_invalid');
  const key=String(line.source_line)+':'+String(line.source_payload.erplainVariantId)+':'+line.target_sku;
  if(expected.has(key))return fail('local_lines_ambiguous');expected.set(key,Number(line.target_quantity));
 }
 if(JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort()))return fail('local_provider_lines_differ');
 return {verified:true,bcId:String(bc.id),blId:String(scope.pending[0].id),blStatus:scope.pending[0].status,lines:[...actual].sort().map(([key,quantity])=>({key,quantity})),excludedFinishedBlIds:scope.finished.map(b=>String(b.id)).sort(),readOnly:true,preparationNotStarted:true};
}

export const pendingBlDiagnosticContext=o=>JSON.stringify({archived:o.archived,partial:o.partial_mode,tracking:o.tracking_status,suspension:o.suspension,source:o.source_payload,erp:o.erp_live});
const localVersion=lines=>JSON.stringify(lines.map(l=>({id:l.id,source_line:l.source_line,target_sku:l.target_sku,target_quantity:l.target_quantity,source_payload:l.source_payload})).sort((a,b)=>String(a.id).localeCompare(String(b.id))));
// Retire only a proven obsolete message. The action, status, stage, business hold,
// documents and label state are deliberately outside this writer's UPDATE.
export function pendingBlDiagnosticReconciler(db,api,{now=()=>Date.now()}={}){
 let nextAt=0;
 return {async run(){
  if(now()<nextAt)return {throttled:true};nextAt=now()+60000;
  const rows=(await db.query(`SELECT r.id,r.order_id,r.action,r.status,r.error,r.result,r.updated_at,to_jsonb(o) AS "order"
   FROM resolution_jobs r JOIN orders o ON o.id=r.order_id
   WHERE r.status='review' AND r.error=$1 AND r.action IN ('refresh','resume','resume-erp')
   AND o.source_payload->>'erplainImported'='true' AND o.source_payload->>'account'='live'
   AND NOT coalesce(o.archived,false) AND NOT coalesce(o.partial_mode,false)
   AND coalesce(o.suspension->>'active','false')<>'true' AND NOT coalesce(o.suspension ? 'erplainCancellation',false)
   AND o.erp_live->'bc'->>'status'='active' AND o.erp_live->'bl'->>'status' IN ('pending','make_the_shipment','in_preparation','ready_to_ship')
   AND r.id=(SELECT latest.id FROM resolution_jobs latest WHERE latest.order_id=o.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs busy WHERE busy.order_id=o.id AND busy.status IN ('queued','running','waiting'))
   ORDER BY r.result->'pendingBlDiagnostic'->>'checkedAt' ASC NULLS FIRST,r.created_at,r.id LIMIT 1`,[noPendingBlError])).rows;
  const row=rows[0];if(!row)return {checked:0};
  const order=row.order,context=pendingBlDiagnosticContext(order);
  const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[order.id])).rows,version=localVersion(lines);
  let proof,calls=0;
  // Early policy checks avoid even a provider read for suspended/invalid cases.
  const initial=pendingBlDiagnosticProof(order,order.erp_live.bc,lines);
  if(['not_live_import','protected_order','validation_hold','bc_not_confirmed','selection_not_confirmed'].includes(initial.reason))proof=initial;
  else try{
   await api.verify();
   const reader={request:(query,variables)=>{if(!/^query\s/.test(query)||++calls>5)throw Error('Read-only diagnostic budget');return api.request(query,variables);}};
   const bc=await readErplainDocuments(reader,order.erp_live.bc.id);proof=pendingBlDiagnosticProof(order,bc,lines);
  }catch{proof=fail('provider_read_unconfirmed');}
  const checkedAt=new Date(now()).toISOString();
  return db.transaction(async tx=>{
   const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
   const latest=(await tx.query('SELECT id,status,error,result,updated_at FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[order.id])).rows[0];
   const freshLines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id FOR SHARE',[order.id])).rows;
   if(!fresh||!latest||latest.id!==row.id||latest.status!=='review'||latest.error!==noPendingBlError||String(latest.updated_at)!==String(row.updated_at)||pendingBlDiagnosticContext(fresh)!==context||localVersion(freshLines)!==version)return {checked:1,changed:0,deferred:'local_state_changed'};
   const busy=(await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')",[order.id])).rows.length;
   if(busy)return {checked:1,changed:0,deferred:'processing'};
   const record={pendingBlDiagnostic:{checkedAt,firstCheckedAt:row.result?.pendingBlDiagnostic?.firstCheckedAt||checkedAt,previousError:noPendingBlError,previousUpdatedAt:row.result?.pendingBlDiagnostic?.previousUpdatedAt||row.updated_at,proof,providerQueries:calls,businessWrites:0}};
   const changed=await tx.query(`UPDATE resolution_jobs SET result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||$3::jsonb,error=$4,updated_at=now()
    WHERE id=$1 AND order_id=$2 AND status='review' AND error=$5 RETURNING id`,[row.id,order.id,JSON.stringify(record),proof.verified?null:noPendingBlError,noPendingBlError]);
   return {checked:1,changed:proof.verified&&changed.rows.length===1?1:0,reason:proof.reason||'selected_bl_verified',businessWrites:0};
  });
 }};
}
