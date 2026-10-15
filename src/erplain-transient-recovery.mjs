import {cancellationBlock,retryDecision,transientErpError} from './erp-transient-policy.mjs';
import {recoverOrder} from './erplain-document-metadata.mjs';

export async function recordTransientFailure(db,o,message,error){
 const old=o.erp_live?.transientRecovery||{};
 const readRateLimited=error?.httpStatus===429&&error?.erplainReadOnly===true;
 const state={...old,originalError:old.originalError||message,lastError:transientErpError(message)?message:null,lastFailureAt:new Date().toISOString(),readRateLimited,
  nextReadCheckAt:readRateLimited?new Date(Date.now()+Math.max(60000,Number(error.retryAfter||0)*1000)).toISOString():null};
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(state)]);
 o.erp_live.transientRecovery=state;
 if(!state.lastError)return message;
 // Preserve the dedicated stock claim/reconciliation protocol and its diagnostic.
 if(['creating_stock','creating_customer'].includes(o.erp_live.phase))return message;
 if(state.readRateLimited)return cancellationBlock(o)||'Erplain temporairement limité : vérification et reprise automatiques programmées';
 return cancellationBlock(o)||((Number(state.attempts||0)>=3)?'Incident temporaire Erplain persistant après 3 reprises : contrôle nécessaire':'Incident temporaire Erplain : rapprochement et reprise automatique en attente ('+Number(state.attempts||0)+'/3)');
}

export async function resumeTransientErplain(db,api){
 await db.transaction(async tx=>{
  const cancelled=(await tx.query(`SELECT o.id,o.source_payload,o.label_status,o.tracking_status,o.issue,o.erp_live,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND e.error NOT LIKE 'Demande d’annulation%' AND e.error NOT LIKE 'Commande annulée%'
   AND (e.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR o.erp_live->'transientRecovery'->>'lastError' IS NOT NULL)
   AND (o.label_status='cancelled' OR o.tracking_status='cancelled' OR coalesce(o.suspension->>'active','false')='true' OR o.suspension ? 'erplainCancellation')
   ORDER BY e.updated_at LIMIT 50 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
  for(const o of cancelled){const block=cancellationBlock(o);if(!block)continue;await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify({...o.erp_live.transientRecovery,lastError:o.erp_live.transientRecovery?.lastError||o.error})]);await tx.query('UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1',[o.id,block]);}
 });
  // Network/quota waits must never hold row locks or a pool connection. The
  // worker run guard serializes passes; the short commit below also rejects any
  // concurrent edit, cancellation, or job replacement made during the read.
  const rows=(await db.query(`SELECT o.*,e.error,e.updated_at retry_updated FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND (e.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR o.erp_live->'transientRecovery'->>'lastError' IS NOT NULL)
   AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
   AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit') AND coalesce(o.label_status,'')<>'cancelled'
   AND NOT (coalesce(o.source_payload,'{}') ? 'marketplacePendingCorrection')


   AND NOT coalesce(o.issue,'') ~* 'commande annulée'
   AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed') AND coalesce(o.erp_live->'bl'->>'status','') NOT IN ('cancelled','closed')
   AND (coalesce(o.erp_live->'transientRecovery'->>'attempts','0') IN ('0','1','2') OR o.erp_live->'transientRecovery'->>'readRateLimited'='true')
   AND (o.erp_live->'transientRecovery'->>'nextReadCheckAt' IS NULL OR o.erp_live->'transientRecovery'->>'nextReadCheckAt'<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND (o.erp_live->>'phase' IN ('creating_bc','bc_created','creating_bl','publishing_bl','bl_created','bl_ready','finalizing_bl') OR (o.erp_live->>'phase' IS NULL AND o.erp_live->'transientRecovery'->>'readRateLimited'='true' AND o.erp_live->'customer'->>'id' IS NULL AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL))
   AND ((o.erp_live->>'phase'='creating_bc' AND o.erp_live->'customer'->>'id' IS NOT NULL) OR (o.erp_live->>'phase'<>'creating_bc' AND o.erp_live->'bc'->>'id' IS NOT NULL) OR o.erp_live->>'phase' IS NULL)
   AND e.updated_at<=now()-CASE coalesce(o.erp_live->'transientRecovery'->>'attempts','0') WHEN '0' THEN interval '30 seconds' WHEN '1' THEN interval '2 minutes' ELSE interval '5 minutes' END
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
   ORDER BY o.resolution_pending_resume ASC,o.archived ASC,o.partial_mode ASC,e.updated_at,o.id LIMIT 10`)).rows;
  let resumed=0,identityRead;
  for(const o of rows){
   const raw=o.erp_live?.transientRecovery?.lastError||o.error;
   if(cancellationBlock(o))continue;
   if(!retryDecision(o,raw,o.retry_updated))continue;
   const recovery={...o.erp_live.transientRecovery,attempts:Number(o.erp_live.transientRecovery?.attempts||0)+1,lastError:raw,checkedAt:new Date().toISOString()};
   let state={...o.erp_live,transientRecovery:recovery},failure=null;
   try{
    // No writes in this preflight. A lost BC response is reconciled by its immutable V3 identity.
    const reader={request:async(q,v)=>{if(!/^query\s/.test(q))throw Error('Rapprochement ERP : lecture seule obligatoire');const result=await api.request(q,v);if(result.Orders){if(!Array.isArray(result.Orders.data)||result.Orders.paginatorInfo?.hasMorePages!==false)throw Error('BC : recherche incomplète');for(const x of result.Orders.data){const identified=x.external_reference==='V3:'+o.id||String(x.internal_notes||'').includes('[V3:'+o.id+']')||x.customer?.customer_number==='V3:'+o.id;if(!identified||!x.id||!['active','unpublished'].includes(x.status))throw Error('BC de même référence ambigu ou non réutilisable : aucune nouvelle création');}}return result;}};
    if(!state.phase){
     // One identity read per bounded pass, rather than one per untouched order.
     const result=await (identityRead??=reader.request('query V3RateLimitIdentity { Company { id } }'));
     if(result.Company?.id!==100174)throw Error('Identité Erplain incorrecte : aucune reprise');
    }else if(state.phase==='creating_bc'){
     const found=await recoverOrder(reader,o);
     if(found){state.bc={id:found.id,label:found.label,status:found.status};state.phase='bc_created';}
     else state.phase='customer_created';
    }else{
     const result=await reader.request('query V3TransientBL($id:ID!){Order(id:$id){id status shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}}}',{id:String(state.bc.id)});
     const bc=result.Order,list=bc?.shipping_orders;
     if(String(bc?.id)!==String(state.bc.id)||bc.status!=='active'||!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false||list.data.length>1)throw Error('BC/BL : rapprochement incomplet ou ambigu, contrôle nécessaire');
     const bl=list.data[0];
     if(bl&&(!bl.id||['cancelled','closed'].includes(bl.status)))throw Error('BL annulé ou non identifiable : contrôle nécessaire');
     if(state.bl?.id&&!bl)throw Error(state.bl.status==='unpublished'?'Brouillon BL introuvable dans Erplain : reprendre depuis le BC après rapprochement':'BL introuvable dans Erplain : rapprochement nécessaire');
     if(state.bl?.id&&String(bl?.id)!==String(state.bl.id))throw Error('BL différent : contrôle nécessaire');
     if(bl)state.bl=bl;
    }
   }catch(e){
    state.transientRecovery.lastError=transientErpError(e.message)?e.message:null;
    state.transientRecovery.readRateLimited=e.httpStatus===429&&e.erplainReadOnly===true;
    state.transientRecovery.nextReadCheckAt=state.transientRecovery.readRateLimited?new Date(Date.now()+Math.max(60000,Number(e.retryAfter||0)*1000)).toISOString():null;
    // A refused verification read consumes no mutation-recovery attempt.
    if(state.transientRecovery.readRateLimited)state.transientRecovery.attempts=Number(o.erp_live.transientRecovery?.attempts||0);
    state.transientRecovery.reconciliationError=e.message;
    failure=state.transientRecovery.readRateLimited?'Erplain temporairement limité : vérification et reprise automatiques programmées':transientErpError(e.message)?'Lecture Erplain temporairement indisponible : rapprochement '+recovery.attempts+'/3':e.message;
   }
   const committed=await db.transaction(async tx=>{
    const fresh=(await tx.query(`SELECT o.*,e.error,e.updated_at retry_updated FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
     WHERE o.id=$1 AND e.status='review' AND e.updated_at=$2 AND o.erp_live=$3::jsonb
     AND NOT coalesce(o.issue,'') ~* 'commande annulée'
     AND NOT (coalesce(o.source_payload,'{}') ? 'marketplacePendingCorrection')
     AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
     AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
     FOR UPDATE OF o,e SKIP LOCKED`,[o.id,o.retry_updated,JSON.stringify(o.erp_live)])).rows[0];
    if(!fresh||!retryDecision(fresh,raw,fresh.retry_updated))return false;
    await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(state)]);
    if(failure)await tx.query('UPDATE erp_live_jobs SET error=$2,updated_at=now() WHERE order_id=$1',[o.id,failure]);
    else await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
    return true;
   });
   if(committed&&!failure)resumed++;
   // A shared quota refusal affects the entire pass. Do not multiply the wait
   // by the number of orders; let unrelated tasks and pending work progress.
   if(failure&&state.transientRecovery.readRateLimited)break;
  }return resumed;
}

export async function closeTransientReviews(db){
 return db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT r.id,r.error,r.updated_at,to_jsonb(o) AS "order" FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE r.status='review' AND r.stage='Erplain à compléter' AND e.status='complete' AND e.error IS NULL
   AND (r.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR (r.error='Erplain temporairement limité : vérification et reprise automatiques programmées' AND o.erp_live->'transientRecovery'->>'readRateLimited'='true' AND o.erp_live->'transientRecovery'->>'lastError' ~* 'Erplain HTTP 429'))
   AND NOT o.resolution_pending_resume AND NOT o.archived AND NOT o.partial_mode
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
   ORDER BY r.updated_at LIMIT 100 FOR UPDATE OF r,o,e SKIP LOCKED`)).rows;
  for(const r of rows){const o=r.order,s=o.erp_live||{};
   const raw=r.error==='Erplain temporairement limité : vérification et reprise automatiques programmées'&&s.transientRecovery?.readRateLimited===true?s.transientRecovery.lastError:r.error;
   if(!transientErpError(raw)||cancellationBlock(o)||o.source_payload?.marketplacePendingCorrection||!s.bc?.id||!s.bl?.id||s.bc.status!=='active'||!['ready_to_ship','make_the_shipment'].includes(s.bl.status)||!s.stockDocument?.id||s.stockDocument.status!=='completed'||s.stockDocument.update_stock!==true||!(new Date(s.verifiedAt).getTime()>new Date(r.updated_at).getTime()))continue;
   await tx.query("UPDATE resolution_jobs SET status='complete',error=null,stage='Incident Erplain résolu',result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify({resolvedPreviousError:r.error,reconciledAt:new Date().toISOString()})]);
  }
 });
}
