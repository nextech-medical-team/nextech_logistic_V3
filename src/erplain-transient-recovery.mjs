import {customerGuard,customerRecoveryError,customerCreationMessage,legacyBcCreationMessage,canRetryCustomerCreation} from './customer-creation-recovery.mjs';
import {erplainCustomerInput} from './erplain-customer-input.mjs';
import {customerCheckpointResult} from './temu-customer-checkpoint.mjs';
import {cancellationBlock,retryDecision,transientErpError,reconciliationError} from './erp-transient-policy.mjs';
import {recoverOrder} from './erplain-document-metadata.mjs';
import {quotaReadRetryAt,quotaWaitingMessage} from './erplain-quota-wait.mjs';
import {reconcilePublicationState} from './publication-recovery.mjs';
import {readTransientBlIdentity} from './transient-bl-identity.mjs';
import {prepareMissingDraftRecovery,commitMissingDraftRecovery} from './missing-draft-recovery.mjs';
import {usesNativeBlCycle} from './native-bl-policy.mjs';
import {randomUUID} from 'node:crypto';

export async function recordTransientFailure(db,o,message,error){
 const old=o.erp_live?.transientRecovery||{};
 const readRateLimited=error?.httpStatus===429&&error?.erplainReadOnly===true;
 const state={...old,originalError:old.originalError||message,lastError:transientErpError(message)?message:customerGuard(o,message)?customerRecoveryError(o,message):null,lastFailureAt:new Date().toISOString(),readRateLimited,
  requestNotSent:error?.erplainRequestNotSent===true,providerRateLimited:error?.httpStatus===429&&(error?.erplainRequestNotSent!==true||error?.erplainProviderRateLimited===true),
  nextReadCheckAt:customerGuard(o,message)&&old.nextReadCheckAt?old.nextReadCheckAt:readRateLimited||canRetryCustomerCreation(o,erplainCustomerInput(o).customer_number)?quotaReadRetryAt(error):null};
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(state)]);
 o.erp_live.transientRecovery=state;
 if(!state.lastError)return message;
 // Preserve the dedicated stock claim/reconciliation protocol and its diagnostic.
 if(['creating_stock','creating_customer'].includes(o.erp_live.phase))return message;
 if(state.readRateLimited)return cancellationBlock(o)||quotaWaitingMessage;
 return cancellationBlock(o)||((Number(state.attempts||0)>=3)?'Incident temporaire Erplain persistant après 3 reprises : contrôle nécessaire':'Incident temporaire Erplain : rapprochement et reprise automatique en attente ('+Number(state.attempts||0)+'/3)');
}

export async function resumeTransientErplain(db,api){
 await db.transaction(async tx=>{
  const cancelled=(await tx.query(`SELECT o.id,o.suspension,o.source_payload,o.label_status,o.tracking_status,o.issue,o.erp_live,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND e.error NOT LIKE 'Demande d’annulation%' AND e.error NOT LIKE 'Commande annulée%'
   AND (e.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR o.erp_live->'transientRecovery'->>'lastError' IS NOT NULL)
   AND (o.label_status='cancelled' OR o.tracking_status='cancelled' OR coalesce(o.suspension->>'active','false')='true' OR o.suspension ? 'erplainCancellation')
   ORDER BY e.updated_at LIMIT 50 FOR UPDATE OF o,e SKIP LOCKED`)).rows;
  for(const o of cancelled){const block=cancellationBlock(o);if(!block)continue;await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify({...o.erp_live.transientRecovery,lastError:o.erp_live.transientRecovery?.lastError||o.error})]);await tx.query('UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1',[o.id,block]);}
 });
  // Network/quota waits must never hold row locks or a pool connection. The
  // worker run guard serializes passes; the short commit below also rejects any
  // concurrent edit, cancellation, or job replacement made during the read.
  const rows=(await db.query(`SELECT o.*,e.error,e.updated_at retry_updated,e.updated_at::text retry_version FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE e.status='review' AND ((o.erp_live->>'phase'='creating_customer' AND e.error IN ($1,$2)) OR (o.erp_live->>'phase'='creating_customer' AND e.error=$1 AND o.erp_live->'transientRecovery'->>'originalError' ~* 'Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError') OR e.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR o.erp_live->'transientRecovery'->>'lastError' IS NOT NULL OR (o.erp_live->>'phase'='publishing_bl' AND e.error ~ 'Publication à vérifier|Traitement interrompu') OR (o.channel<>'tender' AND o.erp_live->'bc'->>'id' IS NOT NULL AND e.error ~ '^(BC/BL : rapprochement incomplet ou ambigu|Brouillon BL introuvable|BL Erplain · Brouillon.*introuvable)'))
   AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
   AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit') AND coalesce(o.label_status,'')<>'cancelled'
   AND NOT (coalesce(o.source_payload,'{}') ? 'marketplacePendingCorrection')


   AND NOT coalesce(o.issue,'') ~* 'commande annulée'
   AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed') AND coalesce(o.erp_live->'bl'->>'status','') NOT IN ('cancelled','closed')
   AND (coalesce(o.erp_live->'transientRecovery'->>'attempts','0') IN ('0','1','2') OR o.erp_live->'transientRecovery'->>'readRateLimited'='true' OR (o.erp_live->>'phase'='creating_customer' AND o.erp_live->'customerCreationAttempt'->>'outcome'='rejected_without_write'))
   AND (o.erp_live->'transientRecovery'->>'nextReadCheckAt' IS NULL OR o.erp_live->'transientRecovery'->>'nextReadCheckAt'<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND (o.erp_live->>'phase' IN ('creating_customer','customer_created','creating_bc','bc_created','creating_bl','publishing_bl','bl_created','bl_ready','finalizing_bl') OR (o.erp_live->>'phase' IS NULL AND o.erp_live->'customer'->>'id' IS NULL AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL))
   AND ((o.erp_live->>'phase'='creating_bc' AND o.erp_live->'customer'->>'id' IS NOT NULL) OR (o.erp_live->>'phase'<>'creating_bc' AND o.erp_live->'bc'->>'id' IS NOT NULL) OR o.erp_live->>'phase' IS NULL OR (o.erp_live->>'phase'='customer_created' AND o.erp_live->'customer'->>'id' IS NOT NULL AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL) OR (o.erp_live->>'phase'='creating_customer' AND o.erp_live->'customer'->>'id' IS NULL AND o.erp_live->'bc'->>'id' IS NULL AND o.erp_live->'bl'->>'id' IS NULL))
   AND e.updated_at<=now()-CASE WHEN o.erp_live->'transientRecovery'->>'readRateLimited'='true' THEN interval '0 seconds' ELSE CASE coalesce(o.erp_live->'transientRecovery'->>'attempts','0') WHEN '0' THEN interval '30 seconds' WHEN '1' THEN interval '2 minutes' ELSE interval '5 minutes' END END
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
   ORDER BY o.resolution_pending_resume ASC,o.archived ASC,o.partial_mode ASC,e.updated_at,o.id LIMIT 10`,[legacyBcCreationMessage,customerCreationMessage])).rows;
  let resumed=0,identityRead;
  for(const o of rows){
   const raw=customerGuard(o,o.error)?o.error:customerRecoveryError(o,o.erp_live?.transientRecovery?.lastError||o.error);
   if(cancellationBlock(o))continue;
   if(!retryDecision(o,raw,o.retry_updated))continue;
   const recovery={...o.erp_live.transientRecovery,attempts:Number(o.erp_live.transientRecovery?.attempts||0)+1,lastError:raw,checkedAt:new Date().toISOString()};
   let state={...o.erp_live,transientRecovery:recovery},failure=null,retiredDraft=null;
   const recoveryId=randomUUID();
   try{
    // No writes in this preflight. A lost BC response is reconciled by its immutable V3 identity.
    const reader={request:async(q,v)=>{
     if(!/^query\s/.test(q))throw Error('Rapprochement ERP : lecture seule obligatoire');
     const freshRead=(await db.query(`SELECT o.* FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
      WHERE o.id=$1 AND e.status='review' AND e.updated_at::text=$2
      AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
      AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))`,[o.id,o.retry_version])).rows[0];
     if(!freshRead||freshRead.archived||freshRead.resolution_pending_resume||freshRead.partial_mode||cancellationBlock(freshRead)||['shipped','delivered','in_transit'].includes(freshRead.tracking_status)||JSON.stringify(freshRead.erp_live)!==JSON.stringify(o.erp_live))throw Error('Commande modifiée ou protégée : rapprochement suspendu');
     const result=await api.request(q,v);
     if(result.Orders){
      if(!Array.isArray(result.Orders.data)||result.Orders.paginatorInfo?.hasMorePages!==false)throw Error('BC : recherche incomplète');
      for(const x of result.Orders.data){
       const identified=x.external_reference==='V3:'+o.id||String(x.internal_notes||'').includes('[V3:'+o.id+']');
       if(!identified||!x.id||!['active','unpublished'].includes(x.status))throw Error('BC de même référence ambigu ou non réutilisable : aucune nouvelle création');
      }
     }
     return result;
    }};
    if(!state.phase){
     // One identity read per bounded pass, rather than one per untouched order.
     const result=await (identityRead??=reader.request('query V3RateLimitIdentity { Company { id } }'));
     if(result.Company?.id!==100174)throw Error('Identité Erplain incorrecte : aucune reprise');
    }else if(['creating_customer','customer_created'].includes(state.phase)){
     const number=erplainCustomerInput(o).customer_number;
     const result=await reader.request('query V3RecoverQuotaCustomer($where:QueryCustomersWhereWhereConditions){Customers(first:100,where:$where){data{id customer_number} paginatorInfo{hasMorePages}}}',{where:{column:'CUSTOMER_NUMBER',operator:'EQ',value:number}});
     const customer=customerCheckpointResult(result,o.id,number);
     state.customerReconciliation={checkedAt:recovery.checkedAt,completeSearch:true,customerId:customer?.id||null,externalWrites:0};
     if(state.customer?.id&&String(customer?.id)!==String(state.customer.id))throw Error('Client Erplain · Client différent : rapprochement nécessaire');
     if(customer){state.customer={...state.customer,...customer};state.phase='customer_created';}
     else if(canRetryCustomerCreation(o,number)){delete state.phase;state.customerReconciliation.retryAuthorizedBy='confirmed_no_write';}
     else throw Error('Client Erplain : creation precedente non retrouvee ; rapprochement requis, aucune nouvelle creation automatique');
    }else if(state.phase==='creating_bc'){
     const found=await recoverOrder(reader,o);
     if(found){state.bc={id:found.id,label:found.label,status:found.status};state.phase='bc_created';}
     else state.phase='customer_created';
    }else{
     const result=await reader.request('query V3TransientBL($id:ID!){Order(id:$id){id status update_stock shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}}}',{id:String(state.bc.id)});
     const bc=result.Order,list=bc?.shipping_orders;
     if(!bc){
      const found=await recoverOrder(reader,o,{db});
      state.documentReconciliation={checkedAt:recovery.checkedAt,savedBcId:String(state.bc.id),candidateBcId:found?.id?String(found.id):null,externalWrites:0};
      throw Error(found?'BC enregistré introuvable ; autre identité V3 retrouvée : rapprochement requis, aucun rattachement automatique':'BC enregistré introuvable et aucune identité V3 retrouvée : contrôle Erplain requis, aucune nouvelle création automatique');
     }
     const draft=bc.status==='unpublished'&&state.phase==='bc_created'&&!state.bl?.id&&!state.stockDocument?.id;
     if(String(bc?.id)!==String(state.bc.id)||!(bc.status==='active'||draft)||!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false||list.data.length>1||draft&&list.data.length)throw Error('BC/BL : rapprochement incomplet ou ambigu, contrôle nécessaire');
     let bl;
     try{bl=await readTransientBlIdentity(reader,state,bc,{lookupDraft:o.channel!=='tender'});}
     catch(e){
      // Only a confirmed absent draft needs the existing no-movement proof.
      // An existing draft must not acquire new transport or stock prerequisites.
      if(e.code!=='V3_MISSING_DRAFT'||o.channel!=='amazon'||!usesNativeBlCycle(o))throw e;
      retiredDraft=await prepareMissingDraftRecovery(db,reader,o,{resolutionId:recoveryId});
      if(!retiredDraft)throw Error('Brouillon BL réapparu pendant le rapprochement : relire avant reprise');
     }
     if(retiredDraft)state={...retiredDraft,transientRecovery:recovery};
     else{
      if(bl)state.bl=bl;
      state.bc={...state.bc,status:bc.status};
      if(o.channel!=='tender')state=reconcilePublicationState(state,bc);
     }
    }
   }catch(e){
    state.transientRecovery.lastError=transientErpError(e.message)?e.message:null;
    state.transientRecovery.readRateLimited=e.httpStatus===429&&e.erplainReadOnly===true;
    state.transientRecovery.nextReadCheckAt=state.transientRecovery.readRateLimited?quotaReadRetryAt(e):null;
    state.transientRecovery.requestNotSent=e.erplainRequestNotSent===true;
    state.transientRecovery.providerRateLimited=e.httpStatus===429&&(e.erplainRequestNotSent!==true||e.erplainProviderRateLimited===true);
    // A refused verification read consumes no mutation-recovery attempt.
    if(state.transientRecovery.readRateLimited)state.transientRecovery.attempts=Number(o.erp_live.transientRecovery?.attempts||0);
    state.transientRecovery.reconciliationError=e.message;
    const canCheckAgain=transientErpError(e.message)||reconciliationError(o,e.message);
    if(!state.transientRecovery.readRateLimited)state.transientRecovery.nextReadCheckAt=canCheckAgain&&recovery.attempts<3?new Date(Date.now()+[30000,120000,300000][Math.min(2,recovery.attempts)]).toISOString():null;
    state.transientRecovery.actionRequired=!state.transientRecovery.nextReadCheckAt;
    state.transientRecovery.outcome=state.transientRecovery.actionRequired?'review_required':'waiting';
    failure=state.transientRecovery.readRateLimited?quotaWaitingMessage:transientErpError(e.message)?'Lecture Erplain temporairement indisponible : rapprochement '+recovery.attempts+'/3':e.message;
   }
   if(!failure)Object.assign(state.transientRecovery,{outcome:'reconciled',actionRequired:false,nextReadCheckAt:null});
   const committed=await db.transaction(async tx=>{
    const fresh=(await tx.query(`SELECT o.*,e.error,e.updated_at retry_updated FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
     WHERE o.id=$1 AND e.status='review' AND e.updated_at::text=$2 AND o.erp_live=$3::jsonb
     AND NOT coalesce(o.issue,'') ~* 'commande annulée'
     AND NOT (coalesce(o.source_payload,'{}') ? 'marketplacePendingCorrection')
     AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
     AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
     FOR UPDATE OF o,e SKIP LOCKED`,[o.id,o.retry_version,JSON.stringify(o.erp_live)])).rows[0];
    if(!fresh||!retryDecision(fresh,raw,fresh.retry_updated))return false;
    if(retiredDraft&&!failure)await commitMissingDraftRecovery(tx,o,state,{resolutionId:recoveryId});
    else await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(state)]);
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

export async function syncSupersededQuotaReviews(tx){
 // A current business refusal supersedes a past quota refusal. Keep the review
 // blocked and preserve the previous reason; this never retries provider work.
 const rows=(await tx.query(`SELECT r.id,r.error,e.error current_error,e.updated_at current_updated,to_jsonb(o) AS "order"
  FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id
  WHERE r.status='review' AND r.stage='Erplain à compléter' AND e.status='review'
  AND r.error IN ('Erplain temporairement limité : vérification et reprise automatiques programmées','Accès Erplain en attente · reprise automatique programmée')
  AND e.error IS NOT NULL AND e.error<>'' AND e.updated_at>=r.updated_at
  AND o.erp_live->'transientRecovery'->>'readRateLimited'='false'
  AND o.erp_live->'transientRecovery'->>'lastError' IS NULL
  AND NOT o.archived AND NOT o.partial_mode AND NOT o.resolution_pending_resume
  AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
  AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting'))
  ORDER BY r.updated_at LIMIT 100 FOR UPDATE OF r,o,e SKIP LOCKED`)).rows;
 for(const r of rows){
  const o=r.order;
  if(cancellationBlock(o)||o.source_payload?.marketplacePendingCorrection||transientErpError(r.current_error)||/^(?:Accès Erplain en attente|Erplain temporairement limité|Incident temporaire Erplain|Lecture Erplain temporairement indisponible)/.test(r.current_error))continue;
  await tx.query("UPDATE resolution_jobs SET error=$2,result=coalesce(result,'{}'::jsonb)||$3::jsonb,updated_at=now() WHERE id=$1",[r.id,r.current_error,JSON.stringify({supersededQuotaError:r.error,currentErpErrorAt:r.current_updated,diagnosticAuthority:'current_erp_review',diagnosticSyncedAt:new Date().toISOString()})]);
 }
}

export async function closeTransientReviews(db){
 return db.transaction(async tx=>{
  await syncSupersededQuotaReviews(tx);
  const rows=(await tx.query(`SELECT r.id,r.error,r.updated_at,to_jsonb(o) AS "order" FROM resolution_jobs r JOIN orders o ON o.id=r.order_id JOIN erp_live_jobs e ON e.order_id=o.id
   WHERE r.status='review' AND r.stage='Erplain à compléter' AND e.status='complete' AND e.error IS NULL
   AND (r.error ~* 'deadlock|SQLSTATE.40001.|lock wait timeout|Erplain HTTP (429|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError' OR (r.error IN ('Erplain temporairement limité : vérification et reprise automatiques programmées','Accès Erplain en attente · reprise automatique programmée') AND o.erp_live->'transientRecovery'->>'readRateLimited'='true' AND o.erp_live->'transientRecovery'->>'lastError' ~* 'Erplain HTTP 429'))
   AND NOT o.resolution_pending_resume AND NOT o.archived AND NOT o.partial_mode
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs a WHERE a.order_id=o.id AND a.status IN ('queued','running','waiting'))
   ORDER BY r.updated_at LIMIT 100 FOR UPDATE OF r,o,e SKIP LOCKED`)).rows;
  for(const r of rows){const o=r.order,s=o.erp_live||{};
   const raw=['Erplain temporairement limité : vérification et reprise automatiques programmées',quotaWaitingMessage].includes(r.error)&&s.transientRecovery?.readRateLimited===true?s.transientRecovery.lastError:r.error;
   // The current BC/BL reservation flow deliberately has no separate stock
   // removal. Its worker completion plus fresh bl_ready proof is authoritative;
   // never require a new document or provider write just to retire an old error.
   const stockComplete=!!s.stockDocument?.id&&s.stockDocument.status==='completed'&&s.stockDocument.update_stock===true;
   const bcFlowComplete=s.bc?.update_stock===true&&s.phase==='bl_ready';
   if(!transientErpError(raw)||cancellationBlock(o)||o.source_payload?.marketplacePendingCorrection||!s.bc?.id||!s.bl?.id||s.bc.status!=='active'||!['ready_to_ship','make_the_shipment'].includes(s.bl.status)||(!stockComplete&&!bcFlowComplete)||!(new Date(s.verifiedAt).getTime()>new Date(r.updated_at).getTime()))continue;
   await tx.query("UPDATE resolution_jobs SET status='complete',error=null,stage='Incident Erplain résolu',result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify({resolvedPreviousError:r.error,reconciledAt:new Date().toISOString(),verifiedAt:s.verifiedAt,completionAuthority:bcFlowComplete?'completed_bc_bl_flow':'completed_stock_document'})]);
  }
 });
}
