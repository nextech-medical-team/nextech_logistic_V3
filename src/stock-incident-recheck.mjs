import {createHash} from 'node:crypto';
import {usesRecordedBc,recordedBcFingerprint} from './existing-bc-execution.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';
import {currentMappingFingerprint} from './current-mapping-line.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {readHistoricalStock} from './historical-stock-proof.mjs';

// Deliberately narrow: mixed/unknown diagnostics must not be retired.
export function stockIncidentOnly(message){
 if(typeof message!=='string')return false;
 const text=message.replace(/^Préparation V3 à vérifier · /,'');
 if(text==='Stock insuffisant')return true;
 return /^BL bloqué [—-] stock insuffisant : [^:;]+ : [\d.]+ nécessaires, [\d.]+ utilisables, manque [\d.]+(?: ; [^:;]+ : [\d.]+ nécessaires, [\d.]+ utilisables, manque [\d.]+)*$/.test(text);
}
export function closedStockReview(job){return job?.error==null&&job?.result?.stockIncidentRecheck?.status==='resolved'&&stockIncidentOnly(job.result.stockIncidentRecheck.previousError);}
export function reopenedStockReview(job){return !!job?.error&&job?.result?.stockIncidentRecheck?.status==='resolved'&&stockIncidentOnly(job.result.stockIncidentRecheck.previousError);}
const sum=rows=>{if(!Array.isArray(rows))throw Error('Lignes non reçues');const totals=new Map();for(const l of rows){if(!l.variant){if(l.type==='normal')throw Error('Variante non vérifiable');continue;}const q=l.quantity;if(!l.variant.id||!l.location?.id||q==null||typeof q==='boolean'||String(q).trim()===''||!Number.isFinite(Number(q))||Number(q)<=0)throw Error('Quantités ou emplacements non vérifiables');const key=String(l.variant.id)+':'+String(l.location.id);totals.set(key,(totals.get(key)||0)+Number(q));}if(!totals.size)throw Error('Aucun produit vérifiable');return totals;};
const equal=(a,b)=>a.size===b.size&&[...a].every(([k,q])=>Math.abs(q-(b.get(k)??NaN))<1e-6);
export function evaluateStockIncident(order,bc,{historicalProof=null}={}){
 if(!bc?.id||String(bc.id)!==String(order.erp_live?.bc?.id)||bc.status!=='active'||typeof bc.update_stock!=='boolean')throw Error('BC actif ou politique stock non confirmés');
 if(order.partial_mode||order.archived||suspensionBlock(order))throw Error('Périmètre partiel, suspendu ou archivé : contrôle dédié requis');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Historique BL incomplet');
 const p=order.erp_live||{},wanted=sum(bc.line_items),active=bc.shipping_orders.data.filter(b=>!['cancelled','unpublished'].includes(b.status));
 if(p.bl?.id){
  const matches=active.filter(b=>String(b.id)===String(p.bl.id));
  if(matches.length!==1||active.length!==1||!['ready_to_ship','shipped','delivered','completed'].includes(matches[0].status)||!equal(wanted,sum(matches[0].line_items)))throw Error('Quantités ou état BL non confirmés');
  if(bc.update_stock===false){const s=p.stockDocument;if(matches[0].update_stock!==false||s?.status!=='completed'||s.update_stock!==true||!s.id||!equal(wanted,sum(s.line_items)))throw Error('Débit complet du BL non confirmé');return {status:'resolved',basis:'stock_removal_covers_bl',bcId:String(bc.id),blId:String(matches[0].id),stockId:String(s.id)};}
  if(String(historicalProof?.bcId)!==String(bc.id)||historicalProof.stockOnBc!==true||!Array.isArray(historicalProof.quantities)||!equal(wanted,new Map(historicalProof.quantities.map(x=>[x.key,x.quantity]))))throw Error('Journal de débit BC non confirmé');
  return {status:'resolved',basis:'verified_bc_ledger',bcId:String(bc.id),blId:String(matches[0].id),logIds:historicalProof.logIds};
 }
 if(active.length)throw Error('BL ou débit historique existant : rapprochement requis');
 if(bc.update_stock===true&&(String(historicalProof?.bcId)!==String(bc.id)||historicalProof.reservationVerified!==true||historicalProof.physicalDebitVerified!==false))throw Error('Réservation BC sans débit physique non confirmée');
 try{assertFullOrderStock(bc.line_items,{preserveInstalled:order.channel==='tender'});}catch(e){if(stockIncidentOnly(e.message))return {status:'active',basis:'current_available_stock',currentError:e.message,bcId:String(bc.id)};throw e;}
 return {status:'resolved',basis:'current_available_stock',bcId:String(bc.id),preparationRequired:true};
}
export async function reconcileStockIncident(db,api,id,{bc,comparison,readError,now=()=>Date.now()}={}){
 const initial=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!initial)return {notApplicable:true};
 if(initial.archived||initial.partial_mode||suspensionBlock(initial)||initial.erp_live?.mappingAlignmentAttempt?.status==='uncertain')return {deferred:true,reason:'Périmètre archivé, partiel, suspendu ou résultat de mapping incertain'};
 const jobs=(await db.query("SELECT id,action,status,error,result,created_at,updated_at FROM resolution_jobs WHERE order_id=$1 AND status='review'",[id])).rows;
 const completedRows=(await db.query("SELECT id,action,status,error,result,created_at,updated_at FROM resolution_jobs WHERE order_id=$1 AND status='complete' ORDER BY created_at DESC,id DESC",[id])).rows;
 const completed=completedRows.find(j=>['resume','resume-erp','replace-equivalent'].includes(j.action)&&!j.error&&!j.result?.partialRemainder);

 const erp=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0];
 if(!stockIncidentOnly(initial.issue)&&!stockIncidentOnly(erp?.error)&&!jobs.some(j=>stockIncidentOnly(j.error)))return {notApplicable:true};
 const frozen=usesRecordedBc(initial),fingerprint=await shipmentFingerprint(db,initial);
 let mapping=null,proof;
 try{
  if(readError)throw Error(readError);
  mapping=frozen?recordedBcFingerprint(bc):await currentMappingFingerprint(db,initial);
  if(comparison?.concordant!==true||comparison.mappingFingerprint!==mapping||(frozen&&comparison.authority!=='recorded_bc'))throw Error(frozen?'Lecture du BC enregistré et de ses BL non confirmée':'Produits/quantités V3 et BC non confirmés');
  if(initial.erp_live?.documentSource?.stockHolds?.length)throw Error('Mouvement de stock à rapprocher');
  let historicalProof=null;
  if(bc?.update_stock===true){const actual=(await api.request('query V3StockIncidentCreated($id:ID!){Order(id:$id){id created_at}}',{id:String(bc.id)})).Order;if(String(actual?.id)!==String(bc.id))throw Error('Identité BC non confirmée');historicalProof=(await readHistoricalStock(api,{...bc,created_at:actual.created_at},{bl:initial.erp_live.bl,reservationOnly:!initial.erp_live.bl?.id})).proof;}
  proof=evaluateStockIncident(initial,bc,{historicalProof});
 }catch(e){proof={status:'unverified',currentError:'Stock : vérification impossible — '+e.message};}
 proof={...proof,checkedAt:new Date(now()).toISOString(),mappingFingerprint:mapping,...(frozen?{authority:'recorded_bc'}:{}),shipmentFingerprint:fingerprint,readOnly:true,preparationNotStarted:true};
 const version=createHash('sha256').update(JSON.stringify([initial.issue,initial.erp_live,initial.partial_mode,initial.suspension,initial.source_payload])).digest('hex');
 return db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];await assertDocumentIdle(tx,id);
  if(!o||createHash('sha256').update(JSON.stringify([o.issue,o.erp_live,o.partial_mode,o.suspension,o.source_payload])).digest('hex')!==version||(!frozen&&await currentMappingFingerprint(tx,o)!==mapping)||await shipmentFingerprint(tx,o)!==fingerprint)return {deferred:true};
  const current=(await tx.query("SELECT id,action,status,error,result,created_at,updated_at FROM resolution_jobs WHERE order_id=$1 AND status='review' FOR UPDATE",[id])).rows;
  if(current.some(j=>!jobs.some(old=>old.id===j.id&&old.error===j.error&&String(old.updated_at)===String(j.updated_at))))return {deferred:true};
  const e=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[id])).rows[0];
  if(e?.status!==erp?.status||e?.error!==erp?.error)return {deferred:true};
  proof.erpError=e?.error||null;proof.observedErrors=current.filter(j=>stockIncidentOnly(j.error)).map(j=>j.error);
  if(proof.status==='resolved'){
   const retired=current.filter(j=>stockIncidentOnly(j.error)&&(proof.preparationRequired?['refresh','sync','resume','resume-erp'].includes(j.action):completed&&Number.isFinite(Date.parse(j.created_at))&&Date.parse(j.created_at)<Date.parse(completed.created_at)));
   proof.retiredErrors=retired.map(j=>j.error);
   const retained=current.filter(j=>j.error&&!retired.some(r=>r.id===j.id));
   if(!proof.preparationRequired&&!completed)return {deferred:true,reason:'Reprise complète réussie non identifiée'};
   for(const j of retired)await tx.query("UPDATE resolution_jobs SET error=null,result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||$2::jsonb,updated_at=now() WHERE id=$1 AND error=$3",[j.id,JSON.stringify({stockIncidentRecheck:{...proof,previousError:j.error}}),j.error]);
   if(!proof.preparationRequired&&stockIncidentOnly(e?.error))await tx.query('UPDATE erp_live_jobs SET error=null,updated_at=now() WHERE order_id=$1 AND error=$2',[id,e.error]);
   const previousError=o.erp_live?.stockIncidentRecheck?.previousError||o.issue;
   const trackedIssue=stockIncidentOnly(o.erp_live?.stockIncidentRecheck?.previousError)&&o.issue===o.erp_live.stockIncidentRecheck.currentError;
   const issue=(stockIncidentOnly(o.issue)||trackedIssue)&&!retained.some(j=>stockIncidentOnly(j.error))?(proof.preparationRequired?'Préparation à reprendre : stock disponible':null):o.issue;
   // Incident closure never grants preparation readiness; the existing full
   // reconciliation must still validate addresses, pricing, labels and holds.
   await tx.query("UPDATE orders SET issue=$2,erp_live=jsonb_set(erp_live,'{stockIncidentRecheck}',$3::jsonb,true) WHERE id=$1",[id,issue,JSON.stringify({...proof,previousError,currentIssue:issue})]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:stock-incident-recheck','diagnostic.stock_incident_resolved',$1)",[JSON.stringify({orderId:id,proof,previousError,retiredJobs:retired.map(j=>({id:j.id,error:j.error})),labelsPreserved:true,businessCompleted:false})]);
  }else {const old=o.erp_live?.stockIncidentRecheck,tracked=stockIncidentOnly(o.issue)||(stockIncidentOnly(old?.previousError)&&o.issue===old.currentError);proof.previousError=old?.previousError||o.issue;await tx.query("UPDATE orders SET issue=CASE WHEN $3 THEN $4 ELSE issue END,erp_live=jsonb_set(erp_live,'{stockIncidentRecheck}',$2::jsonb,true) WHERE id=$1",[id,JSON.stringify(proof),tracked,proof.currentError]);}
  return proof;
 });
}
