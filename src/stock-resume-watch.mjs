import {reconcileNativeBcDebit} from './native-bc-debit-recovery.mjs';
import {initializeGroupedStockWatch,groupedStockPass} from './grouped-stock-watch.mjs';
import {groupedStockEnabled} from './erplain-efficiency-policy.mjs';
import {usesNativeBlCycle,assertNativeBlOrder} from './native-bl-policy.mjs';
import {randomUUID} from 'node:crypto';
import {assertFullOrderStock,assertStockResolved,isStockLockMessage} from './stock-gate.mjs';
import {cancellationBlock,transientErpError} from './erp-transient-policy.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {erplainAccount} from './erplain-accounts.mjs';

export async function initializeStockResumeWatch(db,{resumeReadLeases=false}={}){await initializeGroupedStockWatch(db);await db.exec(`CREATE TABLE IF NOT EXISTS stock_resume_watch(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,next_at TIMESTAMPTZ NOT NULL DEFAULT now(),checked_at TIMESTAMPTZ,failures INT NOT NULL DEFAULT 0,outcome TEXT,last_error TEXT); CREATE INDEX IF NOT EXISTS stock_resume_watch_due ON stock_resume_watch(next_at);`);if(resumeReadLeases)await db.query("UPDATE stock_resume_watch SET next_at=now(),outcome='waiting' WHERE outcome='checking' AND order_id IN (SELECT id FROM orders WHERE channel<>'tender')");}
export const stockCandidateSql=`SELECT o.*,e.error stock_error,e.updated_at erp_updated_at,c.stock_override,c.status carrier_state,
 (SELECT action FROM resolution_jobs r WHERE r.order_id=o.id ORDER BY created_at DESC LIMIT 1) latest_action,
 (SELECT status FROM resolution_jobs r WHERE r.order_id=o.id ORDER BY created_at DESC LIMIT 1) latest_status
 FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id LEFT JOIN carrier_jobs c ON c.order_id=o.id
 WHERE e.status='review' AND (e.error LIKE 'BL bloqué%stock insuffisant%' OR e.error='En attente de stock : BC disponible, préparation du BL suspendue' OR e.error='Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison' OR e.error LIKE 'Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison · %')
 AND NOT o.archived AND NOT o.partial_mode AND o.erp_live->'bc'->>'status'='active'
 AND o.erp_live->>'phase'='bc_created' AND o.erp_live->'bl'->>'id' IS NULL
 AND o.erp_live->'stockDocument'->>'id' IS NULL
 AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated')
 AND coalesce(o.label_status,'')<>'cancelled'
 AND (NOT o.resolution_pending_resume OR (c.status='ready' AND c.stock_override IS NOT NULL))
 AND (c.order_id IS NULL OR c.status='ready')
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM partial_deliveries p WHERE p.order_id=o.id)`;
export function candidateAllowed(o){
 if(cancellationBlock(o)||o.source_payload?.marketplacePendingCorrection)return false;
 if(o.resolution_pending_resume)return o.latest_action==='force-stock-label'&&o.latest_status==='complete'&&o.carrier_state==='ready'&&!!o.stock_override?.fingerprint;
 return true;
}
export function retryMinutes(failures){return Math.min(60,5*2**Math.min(4,Math.max(0,Number(failures)||0)));}
export function verifiedStock(snapshot,bcId,{native=false,preserveInstalled=false}={}){
 if(!snapshot||String(snapshot.id)!==String(bcId)||snapshot.status!=='active'||snapshot.update_stock!==(native?true:false))throw Error('BC à vérifier avant reprise automatique');
 if(!Array.isArray(snapshot.shipping_orders?.data)||snapshot.shipping_orders.paginatorInfo?.hasMorePages!==false||snapshot.shipping_orders.data.length)throw Error('BL existant ou réponse BL incomplète : rapprochement requis');
 if(!Array.isArray(snapshot.line_items)||!snapshot.line_items.some(l=>l.variant))throw Error('Lignes produit absentes');
 assertFullOrderStock(snapshot.line_items,{preserveInstalled});
}
export async function verifiedStockForResume(api,snapshot,o){
 try{return verifiedStock(snapshot,o.erp_live.bc.id,{native:usesNativeBlCycle(o),preserveInstalled:o.channel==='tender'});}
 catch(error){if(!usesNativeBlCycle(o)||!/^BL bloqué [—-] stock insuffisant :/.test(error.message))throw error;
 // A historical debit requires an identifiable document date. Missing
 // metadata remains a normal shortage; do not turn it into a failed poll.
 const created=snapshot?.created_at||o.erp_live?.bc?.created_at;
 if(typeof created!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]/.test(created)||!Number.isFinite(Date.parse(created)))throw error;
 const candidate=structuredClone(o);candidate.items=snapshot.line_items;
 if(!await reconcileNativeBcDebit(api,candidate,snapshot))throw error;
 }
}
const fields='id status created_at update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}';
export function stockResumeWorker(db,directory,{api=erplainAccount(directory,'source'),enabled=()=>true,grouped=groupedStockEnabled,observe=async()=>{},now=()=>Date.now()}={}){
 let running=false;
 async function record(id,problem,preserveInstalled=false){const error=typeof problem==='string'?problem:problem?.message||null,lock=isStockLockMessage(error),quota=problem?.httpStatus===429||problem?.erplainRequestNotSent===true,retrySeconds=preserveInstalled?null:quota?Math.max(2,Number(problem.retryAfter)||30):transientErpError(error)?30:null;await db.query(`INSERT INTO stock_resume_watch(order_id,checked_at,next_at,failures,outcome,last_error) VALUES($1,now(),now()+coalesce($5::double precision,300)*interval '1 second',$3,$4,$2) ON CONFLICT(order_id) DO UPDATE SET checked_at=now(),next_at=now()+CASE WHEN $5::double precision IS NOT NULL THEN $5::double precision*interval '1 second' ELSE make_interval(mins=>CASE WHEN $3=0 THEN 5 ELSE least(60,5*power(2,least(4,stock_resume_watch.failures))::int) END) END,failures=CASE WHEN $3=0 THEN 0 ELSE stock_resume_watch.failures+1 END,outcome=$4,last_error=$2`,[id,error||null,error&&!lock&&!/stock insuffisant/i.test(error)?1:0,lock?'waiting_reconciliation':error?'waiting':'queued',retrySeconds]);
  if(lock)await db.query("UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1 AND status='review' AND (error=$3 OR error LIKE $4)",[id,error,'Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison','Mouvement de stock précédent à rapprocher pour ces produits avant nouvelle livraison · %']);
 }
 async function enqueue(o,fingerprint){return db.transaction(async tx=>{
  const fresh=(await tx.query(stockCandidateSql+' AND o.id=$1 FOR UPDATE OF o,e',[o.id])).rows[0];
  if(!fresh||!enabled()||!candidateAllowed(fresh)||String(fresh.erp_updated_at)!==String(o.erp_updated_at)||String(fresh.erp_live.bc.id)!==String(o.erp_live.bc.id))return false;
  if(await shipmentFingerprint(tx,fresh)!==fingerprint)return false;
  if(fresh.resolution_pending_resume&&fresh.stock_override.fingerprint!==fingerprint)return false;
  await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
  await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
  const id=randomUUID();await tx.query(`INSERT INTO resolution_jobs(id,order_id,request_id,action,status,stage,payload,result) VALUES($1,$2,$1,'resume-erp','waiting','Stock disponible · préparation du BL',$3,$4)`,[id,o.id,JSON.stringify({automaticStockResume:true}),JSON.stringify({resume:true,automaticStockResume:true,...(o.channel==='temu'?{erpOnly:true}:{labelRequested:o.carrier_state==='ready'})})]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('stock-watch','stock.automatic_resume',$1)",[JSON.stringify({orderId:o.id,bcId:o.erp_live.bc.id,resolutionId:id,existingLabelPreserved:o.carrier_state==='ready'})]);
  return true;
 });}
 return {get running(){return running;},async run(){
  if(running||!enabled())return;running=true;
  try{
   if(!(await db.query("SELECT value FROM settings WHERE key='automatic_live'")).rows[0]?.value?.enabled)return;
   if(grouped()){
    const pass=()=>groupedStockPass(db,api,{candidateSql:stockCandidateSql,allowed:candidateAllowed,fingerprint:o=>shipmentFingerprint(db,o),enabled,observe,now,enqueue,record,
     readOrder:async o=>{assertNativeBlOrder(o);await api.verify();return (await api.request('query V3StockResume($b0:ID!){b0:Order(id:$b0){'+fields+'}}',{b0:String(o.erp_live.bc.id)})).b0;},
     verified:async(snapshot,o)=>{assertNativeBlOrder(o);await verifiedStockForResume(api,snapshot,o);}});
    // The worker already owns the background leader and this instance's
    // running guard. Do not hold a pooled SQL connection across provider reads.
    // Admission itself rechecks/locks the live order in its short transaction.
    await pass();
   }
   const rows=(await db.query(stockCandidateSql+(grouped()?` AND NOT (coalesce(o.erp_live->>'bcReservationPolicy','')='erplain_bc_bl' AND coalesce(o.source_payload->>'erplainImported','false')<>'true' AND o.channel<>'tender')`:'')+` AND NOT EXISTS(SELECT 1 FROM stock_resume_watch w WHERE w.order_id=o.id AND w.next_at>now()) ORDER BY o.processing_priority_at ASC NULLS LAST,e.updated_at,o.id LIMIT 20`)).rows.filter(candidateAllowed);
   if(!rows.length)return;
   // Lease each read before any network call, preventing rapid repeats after a failure.
   for(const o of rows)await db.query(`INSERT INTO stock_resume_watch(order_id,next_at,outcome) VALUES($1,now()+interval '5 minutes','checking') ON CONFLICT(order_id) DO UPDATE SET next_at=now()+interval '5 minutes',outcome='checking'`,[o.id]);
   try{await api.verify();}catch(e){for(const o of rows)await record(o.id,e.message,o.channel==='tender');return;}
   for(let start=0;start<rows.length&&enabled();start+=5){
    const batch=rows.slice(start,start+5),fingerprints=await Promise.all(batch.map(o=>shipmentFingerprint(db,o)));
    const q='query V3StockResume('+batch.map((_,i)=>'$b'+i+':ID!').join(',')+'){'+batch.map((_,i)=>`b${i}:Order(id:$b${i}){${fields}}`).join(' ')+'}';
    let result;try{result=await api.request(q,Object.fromEntries(batch.map((o,i)=>['b'+i,String(o.erp_live.bc.id)])));}catch(e){for(const o of batch)await record(o.id,e.message,o.channel==='tender');break;}
    for(let i=0;i<batch.length;i++){const o=batch[i];try{
     if(!enabled())break;
     if(usesNativeBlCycle(o))assertNativeBlOrder(o);
     await verifiedStockForResume(api,result['b'+i],o);
     if(!usesNativeBlCycle(o))await assertStockResolved(db,result['b'+i].line_items.filter(l=>l.variant).map(l=>l.variant.id),{orderId:o.id});
     if(o.resolution_pending_resume&&o.stock_override.fingerprint!==fingerprints[i])throw Error('Préparation modifiée depuis l’étiquette forcée : validation manuelle requise');
     const queued=await enqueue(o,fingerprints[i]);await record(o.id,queued?null:'Commande modifiée ou déjà traitée : relecture différée',o.channel==='tender');
    }catch(e){await record(o.id,e.message,o.channel==='tender');}}
   }
  }finally{running=false;}
 }};
}
