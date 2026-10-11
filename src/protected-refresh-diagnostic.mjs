import {createHash} from 'node:crypto';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {currentMappingLine} from './current-mapping-line.mjs';
import {suspensionBlock} from './order-suspension.mjs';

export const protectedRefreshReason='Préparation protégée : vérifier la commande';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const busy="SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1";
const relevant=r=>r.status==='review'&&r.action==='refresh'&&r.error===protectedRefreshReason&&r.payload?.resumeAfter!==false&&Array.isArray(r.result?.checks)&&r.result.checks.length===1&&r.result.checks[0].id===r.order_id&&r.result.checks[0].protected===true&&!r.result.checks[0].problem&&!r.result.checks[0].error;
const allowed=o=>o&&!o.archived&&!o.duplicate_of&&!o.partial_mode&&!suspensionBlock(o)&&!o.issue&&!o.resolution_pending_resume&&!['cancelled','cancellation_requested'].includes(o.label_status)&&o.tracking_status!=='cancelled'&&o.erp_status==='live_created'&&o.erp_live?.phase==='bl_ready'&&o.erp_live?.bc?.id&&o.erp_live?.bl?.id&&!o.source_payload?.visibilityHold&&!o.source_payload?.erplainValidationHold&&!o.source_payload?.marketplacePendingCorrection&&!o.erp_live?.documentSource?.stockHolds?.length&&o.erp_live?.mappingAlignmentAttempt?.status!=='uncertain';
const number=v=>v!==null&&v!==undefined&&typeof v!=='boolean'&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>0;
function quantities(lines,{sku=false}={}){
 if(!Array.isArray(lines))throw Error('Lignes de préparation non reçues');
 const totals=new Map();
 for(const l of lines){
  if(l.type==='shipping_cost')continue;
  if(!sku&&!l.variant){if(l.type==='normal')throw Error('Variante de préparation non reçue');continue;}
  const key=sku?l.sku||l.variant?.sku:l.variant?.id&&l.location?.id?String(l.variant.id)+':'+String(l.location.id):null;
  if(!key||!number(l.quantity))throw Error('Quantité, produit ou emplacement non vérifiable');
  totals.set(String(key),(totals.get(String(key))||0)+Number(l.quantity));
 }
 if(!totals.size)throw Error('Préparation sans produits vérifiables');
 return [...totals].sort(([a],[b])=>a.localeCompare(b));
}
const same=(a,b)=>a.length===b.length&&a.every(([k,q],i)=>k===b[i][0]&&Math.abs(q-b[i][1])<1e-6);
const normalize=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();
const currentActions=actions=>[...new Map([...actions].reverse().map(j=>[j.action,j])).values()];
export function protectedRefreshProof({order:o,review:r,erp,bc,stock,lines,currentFingerprint,labels,checkedAt,now=Date.now()}){
 if(!allowed(o)||!relevant(r)||r.order_id!==o.id||erp?.status!=='complete'||erp.error!==null)return null;
 const old=Math.max(Date.parse(r.created_at),Date.parse(r.updated_at));
 if(!Number.isFinite(old)||[erp.updated_at,o.erp_live.verifiedAt,o.erp_live.stockCheckedAt,o.erp_live.bl.readyConfirmedAt].some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)>now))return null;
 const observed=Date.parse(checkedAt);if(!Number.isFinite(observed)||observed<=old||observed>now||now-observed>5*60000)return null;
 if(!/^[a-f0-9]{64}$/.test(currentFingerprint||'')||o.erp_live.labelPreparationFingerprint!==currentFingerprint)return null;
 if(!Array.isArray(labels)||!labels.length||labels.some(d=>!(Number(d.bytes)>0)||d.signature!=='%PDF-'||!d.fingerprint))return null;
 if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||bc.external_reference!==o.reference||bc.update_stock!==false||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)return null;
 const active=bc.shipping_orders.data.filter(b=>!['cancelled','unpublished'].includes(b.status));
 if(active.length!==1)return null;const bl=active[0];
 if(String(bl.id)!==String(o.erp_live.bl.id)||!['ready_to_ship','shipped','delivered','completed'].includes(bl.status)||bl.external_reference!==o.reference||bl.update_stock!==false)return null;
 for(const key of ['label','address_1','postal_code','city','country'])if(!normalize(bc.shipping_address?.[key])||normalize(bc.shipping_address[key])!==normalize(bl.shipping_address?.[key]))return null;
 if(String(stock?.id)!==String(o.erp_live.stockDocument?.id)||stock.label!==o.erp_live.stockDocument.label||stock.status!=='completed'||stock.update_stock!==true||stock.notes!=='LIVE : sortie de stock liée au BL '+bl.label)return null;
 try{
  if(!same(quantities(bc.line_items),quantities(bl.line_items))||!same(quantities(bl.line_items),quantities(stock.line_items))||!same(quantities(lines.map(l=>currentMappingLine(l,o.channel)),{sku:true}),quantities(bc.line_items,{sku:true})))return null;
 }catch{return null;}
 return {version:1,checkedAt,bcId:bc.id,blId:bl.id,stockDocumentId:stock.id,preparationFingerprint:currentFingerprint,labels,providerMutations:0,businessCompleted:false};
}
async function labelEvidence(db,o,{lock=true}={}){
 const share=lock?' FOR SHARE':'';
 if(o.channel==='temu'){
  const j=(await db.query('SELECT status,error,packages,result FROM temu_label_jobs WHERE reference=$1'+share,[o.reference])).rows[0];
  const docs=(await db.query("SELECT package,octet_length(pdf) bytes,encode(substring(pdf FROM 1 FOR 5),'escape') signature,md5(encode(pdf,'hex')) fingerprint FROM temu_label_documents WHERE reference=$1 ORDER BY package"+share,[o.reference])).rows;
  if(j?.status!=='complete'||j.error!==null||j.result?.source!=='temu_direct'||!Array.isArray(j.packages)||!j.packages.length||j.packages.some(p=>!docs.some(d=>d.package===p)))return null;
  return docs.filter(d=>j.packages.includes(d.package));
 }
 const j=(await db.query('SELECT status,error,environment,tracking FROM carrier_jobs WHERE order_id=$1'+share,[o.id])).rows[0];
 const docs=(await db.query("SELECT document_index,octet_length(pdf) bytes,encode(substring(pdf FROM 1 FOR 5),'escape') signature,md5(encode(pdf,'hex')) fingerprint FROM carrier_documents WHERE order_id=$1 ORDER BY document_index"+share,[o.id])).rows;
 if(j?.status!=='ready'||j.error!==null||j.environment!=='production'||!Array.isArray(j.tracking)||!j.tracking.length||j.tracking.some((t,i)=>!t||!docs.some(d=>Number(d.document_index)===i)))return null;
 return docs.map(d=>({...d,tracking:j.tracking[Number(d.document_index)]}));
}
async function idle(db,id){await assertDocumentIdle(db,id);if((await db.query(busy,[id])).rows.length)throw Error('Traitement ou colis supplémentaire : rapprochement dédié requis');}
const latestSql='SELECT * FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC';
export async function reconcileProtectedRefresh(db,api,reviewId,{dryRun=false,now=()=>Date.now(),readDocuments=readErplainDocuments}={}){
 const r=(await db.query('SELECT * FROM resolution_jobs WHERE id=$1',[reviewId])).rows[0];if(!r||!relevant(r))return {updated:false,notApplicable:true};
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[r.order_id])).rows[0];if(!allowed(o))return {updated:false,notApplicable:true};
 await idle(db,o.id);
 const actions=(await db.query(latestSql,[o.id])).rows;
 if(actions[0]?.id!==r.id||currentActions(actions).some(j=>j.id!==r.id&&j.status==='review'&&j.error))return {updated:false,independentReview:true};
 const erp=(await db.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1',[o.id])).rows[0];
 const old=Math.max(Date.parse(r.created_at),Date.parse(r.updated_at));
 if(erp?.status!=='complete'||erp.error!==null||!o.erp_live.stockDocument?.id||!Number.isFinite(old)||[erp.updated_at,o.erp_live.verifiedAt,o.erp_live.stockCheckedAt,o.erp_live.bl.readyConfirmedAt].some(t=>!Number.isFinite(Date.parse(t))||Date.parse(t)>now()))return {updated:false};
 const labels=await labelEvidence(db,o,{lock:!dryRun});if(!labels)return {updated:false};
 const currentFingerprint=await shipmentFingerprint(db,o),before=digest(o),reviewVersion=digest(r);
 const lines=(await db.query('SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
 const provider={request:(query,...args)=>{if(!/^\s*query\b/.test(query)||/\bmutation\b/i.test(query))throw Error('Réconciliation : mutation fournisseur interdite');return api.request(query,...args);}};
 await api.verify?.();
 const bc=await readDocuments(provider,o.erp_live.bc.id);
 const stock=(await provider.request('query V3ProtectedRefreshStock($id:ID!){StockRemoval(id:$id){id label status notes update_stock line_items{type quantity variant{id} location{id}}}}',{id:String(o.erp_live.stockDocument?.id||'')})).StockRemoval;
 const checkedAt=new Date(now()).toISOString();
 const proof=protectedRefreshProof({order:o,review:r,erp,bc,stock,lines,currentFingerprint,labels,checkedAt,now:now()});
 if(!proof)return {updated:false,proofNotConfirmed:true};
 if(dryRun)return {updated:false,eligible:true,reviewId:r.id,orderId:o.id,proof};
 return db.transaction(async tx=>{
  const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];await idle(tx,o.id);
  await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[o.id]);
  const current=(await tx.query('SELECT * FROM resolution_jobs WHERE id=$1 FOR UPDATE',[r.id])).rows[0];
  if(!fresh||!current)return {updated:false,changedDuringRead:true};
  const latest=(await tx.query(latestSql,[o.id])).rows;
  const e=(await tx.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[o.id])).rows[0];
  const evidence=await labelEvidence(tx,fresh);
  if(digest(fresh)!==before||digest(current)!==reviewVersion||latest[0]?.id!==r.id||currentActions(latest).some(j=>j.id!==r.id&&j.status==='review'&&j.error)||digest(e)!==digest(erp)||digest(evidence)!==digest(labels)||await shipmentFingerprint(tx,fresh)!==currentFingerprint)return {updated:false,changedDuringRead:true};
  await tx.query('LOCK TABLE mappings IN SHARE MODE');
  const freshLines=(await tx.query('SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
  if(!protectedRefreshProof({order:fresh,review:current,erp:e,bc,stock,lines:freshLines,currentFingerprint,labels:evidence,checkedAt,now:now()}))return {updated:false,proofNotConfirmed:true};
  const result={protectedRefreshReconciliation:{...proof,previousError:r.error,previousStage:r.stage,previousUpdatedAt:r.updated_at,labelsPreserved:true}};
  await tx.query("UPDATE resolution_jobs SET status='complete',stage='Diagnostic résolu · préparation existante vérifiée',error=null,result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1 AND status='review'",[r.id,JSON.stringify(result)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:protected-refresh','diagnostic.protected_refresh_completed',$1)",[JSON.stringify({orderId:o.id,reviewId:r.id,...result})]);
  return {updated:true,reviewId:r.id,orderId:o.id,proof};
 });
}
export function protectedRefreshDiagnosticReconciler(db,api,{now=()=>Date.now(),enabled=()=>true,reconcile=reconcileProtectedRefresh}={}){
 let running=false,next=0;const attempts=new Map();
 return {async run(){
  if(running||now()<next||!enabled())return;running=true;next=now()+60000;
  try{
   const rows=(await db.query("SELECT r.id FROM resolution_jobs r JOIN orders o ON o.id=r.order_id WHERE r.status='review' AND r.action='refresh' AND r.error=$1 AND NOT o.archived AND NOT coalesce(o.partial_mode,false) AND o.erp_live->'bc'->>'id' IS NOT NULL AND o.erp_live->'bl'->>'id' IS NOT NULL ORDER BY r.created_at,r.id",[protectedRefreshReason])).rows;
   let n=0;for(const r of rows){if(!enabled()||n>=5)break;if((attempts.get(r.id)||0)>now())continue;attempts.set(r.id,now()+15*60000);n++;try{await reconcile(db,api,r.id,{now});}catch(e){console.error('Protected refresh reconciliation deferred',e.message);}}
   const found=new Set(rows.map(r=>r.id));for(const id of attempts.keys())if(!found.has(id))attempts.delete(id);
  }finally{running=false;}
 }};
}
