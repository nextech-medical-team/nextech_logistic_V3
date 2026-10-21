import {isDeepStrictEqual} from 'node:util';
import {erplainCustomerInput} from './erplain-customer-input.mjs';
import {customerCheckpointResult} from './temu-customer-checkpoint.mjs';
import {canRetryCustomerCreation,customerCreationMessage,legacyBcCreationMessage,customerPerOrderAllowed} from './customer-creation-recovery.mjs';
import {suspensionBlock} from './order-suspension.mjs';

function assertScope(o){
 const s=o?.erp_live||{},p=o?.source_payload||{};
 if(!o||o.archived||o.partial_mode||suspensionBlock(o)||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled'||p.marketplacePendingCorrection||p.visibilityHold||p.erplainValidationHold||p.erplainImported)throw Error('Commande protégée : rapprochement client suspendu');
 if(!['creating_customer','customer_created'].includes(s.phase)||s.bc?.id||s.bl?.id||s.stockDocument?.id||s.stockCreationAttemptedAt||s.stockPendingVariants?.length)throw Error('Étape de préparation modifiée : actualiser la commande avant rapprochement client');
}
// Only the customer identity is reconciled here. Normal preparation still owns
// admission, BC/BL creation and stock checks; this function never creates a customer.
export async function refreshCustomerIdentity(db,api,o,{confirmAbsent=false,customerNumber,requestId}={}){
 assertScope(o);
 const number=erplainCustomerInput(o).customer_number;
 if(confirmAbsent&&(!customerPerOrderAllowed(o)||customerNumber!==number||!requestId))throw Error('Confirmation du numéro client et de la commande requise');
 const previousAttempt=o.erp_live.customerCreationAttempt;
 if(confirmAbsent&&previousAttempt?.at&&Date.now()-Date.parse(previousAttempt.at)<15*60*1000)throw Error('Tentative client récente : attendre 15 minutes puis vérifier son résultat dans Erplain');
 await api.verify();
 const result=await api.request('query V3RefreshCustomerIdentity($where:QueryCustomersWhereWhereConditions){Customers(first:100,where:$where){data{id customer_number} paginatorInfo{hasMorePages}}}',{where:{column:'CUSTOMER_NUMBER',operator:'EQ',value:number}});
 const customer=customerCheckpointResult(result,o.id,number);
 if(!customer&&confirmAbsent&&o.erp_live.customer?.id){
  const previous=await api.request('query V3PreviousCustomerIdentity($id:ID!){Customer(id:$id){id customer_number}}',{id:String(o.erp_live.customer.id)});
  if(previous?.Customer!==null)throw Error('Ancien client encore présent ou réponse incomplète : vérifier son numéro dans Erplain avant toute création');
 }
 if(o.erp_live.customer?.id&&String(customer?.id)!==String(o.erp_live.customer.id)&&!(confirmAbsent&&!customer))throw Error('Client Erplain différent ou introuvable : aucune nouvelle création');
 if(!customer&&!confirmAbsent&&!canRetryCustomerCreation(o,number))throw Error('Client Erplain introuvable après recherche : création précédente incertaine, aucune nouvelle création automatique');
 return db.transaction(async tx=>{
  const current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
  assertScope(current);
  if(!isDeepStrictEqual(current,o))throw Error('Commande modifiée pendant la recherche : rapprochement client différé');
  if((await tx.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[o.id])).rows.length)throw Error('Traitement concurrent : rapprochement client différé');
  const state={...current.erp_live,customerReconciliation:{checkedAt:new Date().toISOString(),completeSearch:true,customerId:customer?.id||null,externalWrites:0}};
  if(customer){state.customer={...state.customer,...customer};state.phase='customer_created';}
  else {
   delete state.phase;delete state.customer;
   state.customerReconciliation.retryAuthorizedBy=confirmAbsent?'operator_confirmed_absence':'confirmed_no_write';
   if(confirmAbsent)state.customerReconciliation.authorization={requestId,customerNumber:number,previousCustomer:current.erp_live.customer||null,previousAttempt:previousAttempt||null};
  }
  const issue=[customerCreationMessage,legacyBcCreationMessage].includes(current.issue)?null:current.issue;
  await tx.query('UPDATE orders SET erp_live=$2,issue=$3 WHERE id=$1',[o.id,JSON.stringify(state),issue]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','customer.identity_refreshed',$1)",[JSON.stringify({orderId:o.id,...state.customerReconciliation})]);
  return {erpOnly:true,customerReconciliation:state.customerReconciliation,message:customer?'Client Erplain existant retrouvé ; préparation à recontrôler.':confirmAbsent?'Absence du client relue ; nouvelle tentative autorisée explicitement. Préparation à recontrôler.':'Absence du client vérifiée et refus sans écriture confirmé ; préparation à recontrôler.'};
 });
}
