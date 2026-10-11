import {observePreparation,preparationFingerprint,preparationNeedsCheck,preparationCadence} from './preparation-observation.mjs';

export const preparationLinesSql=`SELECT l.source_sku source,
 CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(p.target_sku,l.target_sku,l.source_sku) END sku,
 CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_quantity WHEN p.source_qty>0 THEN round(l.quantity*p.target_qty/p.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END quantity,
 (CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku IS NOT NULL AND l.target_quantity>0 ELSE p.target_sku IS NOT NULL AND p.source_qty>0 AND p.target_qty>0 END) AS "mappingPresent"
 FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings p ON p.channel=o.channel AND p.source_sku=l.source_sku WHERE l.order_id=$1 ORDER BY l.id`;

// Readers use the installed shared API budget and must return fully paginated,
// identity-verified read-only proofs. No supplier write or job queue API exists here.
export function preparationObserverWorker(db,{readDocument,findDocument,readProduct,locationForOrder,enabled=()=>true,now=()=>Date.now(),maxOrders=20,maxProducts=50}={}){
 if([readDocument,findDocument,readProduct,locationForOrder].some(f=>typeof f!=='function'))throw Error('Lecteurs Erplain et dépôt de préparation requis');
 let running=false;
 async function snapshot(tx,id,{lock=false}={}){
  const o=(await tx.query(`SELECT * FROM orders WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
  if(!o)return null;
  const job=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0]||{};
  const active=(await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT id FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting') LIMIT 1",[id])).rows.length;
  if(!preparationNeedsCheck(o,job)||active)return null;
  const lines=(await tx.query(preparationLinesSql,[id])).rows.map(l=>({...l,quantity:Number(l.quantity),locationId:locationForOrder(o)}));
  return {order:o,lines};
 }
 async function run(){
  if(running||!enabled())return {skipped:true};running=true;
  try{return await db.withLocks(['preparation-observation'],async()=>{
   const due=(await db.query(`SELECT m.order_id,m.requested FROM order_recheck_monitor m JOIN orders o ON o.id=m.order_id LEFT JOIN erp_live_jobs e ON e.order_id=o.id
    WHERE (coalesce((m.state->'preparationObservation'->>'expiresAt')::timestamptz,'-infinity')<=now() OR m.state->>'preparationObservedVersion' IS DISTINCT FROM m.requested::text) AND (o.erp_status='live_review' OR e.status='review')
    AND NOT o.archived AND NOT coalesce(o.partial_mode,false) AND coalesce(o.suspension->>'active','false')<>'true' AND NOT (o.suspension ? 'erplainCancellation')
    AND coalesce(e.status,'') NOT IN ('pending','processing','complete') AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
    AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
    ORDER BY coalesce((m.state->'preparationObservation'->>'expiresAt')::timestamptz,'-infinity'),m.order_id LIMIT $1`,[maxOrders])).rows;
   const products=new Map();let productReads=0,persisted=0,deferred=0;
   for(const row of due){
    if(!enabled())break;
    const input=await snapshot(db,row.order_id);if(!input)continue;
    const started=now(),fingerprint=preparationFingerprint(input.order,input.lines);
    const proof={...input,now:started,products:[]};
    try{
     if(input.order.erp_live?.bc?.id)proof.document={bc:await readDocument(input.order.erp_live.bc.id),readAt:new Date(started).toISOString()};
     else{
      const found=await findDocument(input.order);if(found?.complete!==true)throw Error('Recherche BC incomplète');
      proof.documentSearch={...found,readAt:new Date(started).toISOString()};
      if(found.found===null)for(const sku of [...new Set(input.lines.map(l=>l.sku).filter(Boolean))]){
       if(!products.has(sku)){
        if(productReads>=maxProducts)break;
        productReads++;const readAt=new Date(now()).toISOString();
        // Retain rejected promises as well: a failing SKU is read only once per batch.
        products.set(sku,Promise.resolve().then(()=>readProduct(sku)).then(p=>({...p,sku,readAt})));
       }
       if(products.has(sku))proof.products.push(await products.get(sku));
      }
     }
    }catch(e){proof.readError=e.message;}
    proof.now=now();const observation=observePreparation(proof);
    // Serialize only persistence with the local monitor, whose update replaces
    // its JSON snapshot. Supplier reads never hold this local monitoring lock.
    await db.withLocks(['order-recheck-local'],()=>db.transaction(async tx=>{
     const fresh=await snapshot(tx,row.order_id,{lock:true});
     if(!enabled()||!fresh||preparationFingerprint(fresh.order,fresh.lines)!==fingerprint){deferred++;return;}
     // requested changes on source, mappings and correction jobs. Never persist a
     // proof collected against an older request, even if the order looks identical.
     const updated=await tx.query(`UPDATE order_recheck_monitor SET next_check=now(),
      state=state||jsonb_build_object('preparationObservation',$3::jsonb,'preparationObservedVersion',requested)
      WHERE order_id=$1 AND requested=$2 RETURNING order_id`,[row.order_id,row.requested,JSON.stringify(observation)]);
     if(updated.rows.length)persisted++;else deferred++;
    }));
   }
   return {persisted,deferred,productReads,orders:due.length,cadence:preparationCadence.external};
  });}finally{running=false;}
 }
 return {run,get running(){return running;}};
}
