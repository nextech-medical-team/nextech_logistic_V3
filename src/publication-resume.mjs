import {isDeepStrictEqual} from 'node:util';
import {cancellationBlock} from './erp-transient-policy.mjs';
import {prepareMissingDraftRecovery,commitMissingDraftRecovery,assertMissingDraftIdle} from './missing-draft-recovery.mjs';
import {reconcilePublicationState} from './publication-recovery.mjs';

// Explicit user recovery still requires fresh provider evidence after automatic
// retries are exhausted. Never reset publishing_bl without reconciling its BL.
export async function preparePublicationResume(db,api,o,options={}){
 const state=o.erp_live||{};
 if(state.phase!=='publishing_bl')return prepareMissingDraftRecovery(db,api,o,options);
 const {Order:bc}=await api.request('query V3PublicationResume($id:ID!){Order(id:$id){id status update_stock shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}}}',{id:String(state.bc.id)});
 const list=bc?.shipping_orders;
 if(String(bc?.id)!==String(state.bc.id)||bc.status!=='active'||!Array.isArray(list?.data)||list.paginatorInfo?.hasMorePages!==false||list.data.length>1)throw Error('Publication BL : rapprochement incomplet ou ambigu');
 if(!list.data.length){
  const missing=await prepareMissingDraftRecovery(db,api,o,options);
  if(missing)return missing;
  throw Error('Publication BL : BL absent non rapproché');
 }
 const bl=list.data[0];
 if(!bl?.id||!state.bl?.id||String(bl.id)!==String(state.bl.id))throw Error('Publication BL : BL différent ou non confirmé');
 return reconcilePublicationState({...state,bl},bc);
}

export async function commitPublicationResume(tx,o,next,options={}){
 if(next.missingDraftRecoveries?.length>(o.erp_live.missingDraftRecoveries?.length||0))return commitMissingDraftRecovery(tx,o,next,options);
 const current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
 if(!current||!isDeepStrictEqual(current.erp_live,o.erp_live))throw Error('Publication BL modifiée pendant la lecture : reprise différée');
 if(current.archived||current.partial_mode||cancellationBlock(current)||['shipped','delivered','in_transit','delivered_simulated'].includes(current.tracking_status))throw Error('Commande modifiée pendant la lecture : reprise différée');
 await assertMissingDraftIdle(tx,current,options.resolutionId);
 await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(next)]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.publication_reconciled',$2)",[options.userEmail||'system',JSON.stringify({orderId:o.id,bcId:next.bc.id,blId:next.bl.id,phase:next.phase})]);
}
