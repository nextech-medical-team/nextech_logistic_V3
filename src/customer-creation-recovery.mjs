import {erplainCustomerInput} from './erplain-customer-input.mjs';
export const legacyBcCreationMessage='BC Erplain · Création à vérifier : aucun BC confirmé, aucune nouvelle création automatique';
export const customerCreationMessage='Client Erplain · Création à vérifier : rapprocher le client de cette commande avant reprise';
export function customerPerOrderAllowed(o){return ['amazon','temu'].includes(o.channel);}
export function customerCreationStarted(o){return {orderId:o.id,channel:o.channel,number:erplainCustomerInput(o).customer_number,policy:customerPerOrderAllowed(o)?'per_order':'existing_channel_policy',outcome:'sending',at:new Date().toISOString()};}
export function customerCreationFailed(attempt,error){
 const safe=error?.httpStatus===429&&error.erplainReadOnly!==true&&(error.erplainRequestNotSent===true||error.confirmedRateLimitRejection===true);
 return {...attempt,outcome:safe?'rejected_without_write':'uncertain',httpStatus:error?.httpStatus||null,requestNotSent:error?.erplainRequestNotSent===true,confirmedRateLimitRejection:error?.confirmedRateLimitRejection===true};
}
export function canRetryCustomerCreation(o,number){const a=o.erp_live?.customerCreationAttempt;return o.erp_live?.phase==='creating_customer'&&!o.erp_live.customer?.id&&!o.erp_live.bc?.id&&!o.erp_live.bl?.id&&!o.erp_live.stockDocument?.id&&!o.erp_live.stockCreationAttemptedAt&&a?.orderId===o.id&&a?.channel===o.channel&&a?.number===number&&a.outcome==='rejected_without_write'&&a.httpStatus===429&&(a.requestNotSent===true||a.confirmedRateLimitRejection===true);}
export function customerGuard(o,message){return o.erp_live?.phase==='creating_customer'&&[legacyBcCreationMessage,customerCreationMessage].includes(message);}
export function customerRecoveryError(o,message){return customerGuard(o,message)?o.erp_live?.transientRecovery?.lastError||o.erp_live?.transientRecovery?.originalError||message:message;}
