import {canRetryCustomerCreation} from './customer-creation-recovery.mjs';
import {erplainCustomerInput} from './erplain-customer-input.mjs';
import {usesRecordedBc} from './existing-bc-execution.mjs';
import {suspensionBlock} from './order-suspension.mjs';
export function cancellationBlock(o){
 const suspended=suspensionBlock(o);if(suspended)return suspended;
 // Explicit V3 cancellation and carrier evidence remain operational.
 if(o.label_status==='cancelled'||o.tracking_status==='cancelled')return 'Commande annulée dans V3 : préparation suspendue';
 return null;
}
export function transientErpError(message){return /^Réponse incomplète (?:creating_customer|creating_bc|publishing_bl)$/.test(message||'')||/SQLSTATE\[40001\]|\bdeadlock\b|lock wait timeout|Erplain HTTP (429|502|503|504)\b|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError/i.test(message||'')}
export function mutationBlock(o,{allowHeldBc=false}={}){return !o||o.archived?'Commande indisponible':cancellationBlock(o)||(o.resolution_pending_resume&&!allowHeldBc?'Préparation suspendue : validation requise':null);}
export function reconciliationError(o,error){
 return o.channel!=='tender'&&!!o.erp_live?.bc?.id&&/^(?:Réponse Erplain incomplète|BC\/BL : rapprochement incomplet ou ambigu|Brouillon BL introuvable|BL Erplain · Brouillon.*introuvable)/.test(error||'');
}
export function retryDecision(o,error,updatedAt,now=Date.now()){
 const attempts=Number(o.erp_live?.transientRecovery?.attempts||0);
 const safeCustomer=canRetryCustomerCreation(o,erplainCustomerInput(o).customer_number);
 const readLimited=o.erp_live?.transientRecovery?.readRateLimited===true&&/Erplain HTTP 429\b/.test(error||'');
 const interruptedPublication=o.channel!=='tender'&&o.erp_live?.phase==='publishing_bl'&&/Publication à vérifier|Traitement interrompu/.test(error||'');
 if((!transientErpError(error)&&!interruptedPublication&&!reconciliationError(o,error))||!Number.isInteger(attempts)||(attempts>=3&&!readLimited&&!safeCustomer)||attempts<0)return false;
 if(o.archived||o.partial_mode||o.resolution_pending_resume||cancellationBlock(o)||(!usesRecordedBc(o)&&Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection'))||['shipped','delivered','in_transit'].includes(o.tracking_status))return false;
 if(['cancelled','closed'].includes(o.erp_live?.bc?.status)||['cancelled','closed'].includes(o.erp_live?.bl?.status))return false;
 const phase=o.erp_live?.phase;
 const initialRead=!phase&&!o.erp_live?.customer?.id&&!o.erp_live?.bc?.id&&!o.erp_live?.bl?.id;
 if(!initialRead&&!['creating_customer','customer_created','creating_bc','bc_created','creating_bl','publishing_bl','bl_created','bl_ready','finalizing_bl'].includes(phase))return false;
 if(phase==='creating_bc'&&!o.erp_live?.customer?.id)return false;
 if(phase==='creating_customer'&&(o.erp_live?.customer?.id||o.erp_live?.bc?.id||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id||o.erp_live?.stockCreationAttemptedAt))return false;
 if(phase==='customer_created'&&(!o.erp_live?.customer?.id||o.erp_live?.bc?.id||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id||o.erp_live?.stockCreationAttemptedAt))return false;
 if(!initialRead&&phase!=='customer_created'&&phase!=='creating_customer'&&phase!=='creating_bc'&&!o.erp_live?.bc?.id)return false;
 const retryAt=o.erp_live?.transientRecovery?.nextReadCheckAt;
 if(retryAt&&(!Number.isFinite(Date.parse(retryAt))||Date.parse(retryAt)>now))return false;
 return Number.isFinite(Date.parse(updatedAt))&&now-Date.parse(updatedAt)>=(readLimited?0:[30000,120000,300000][Math.min(attempts,2)]);
}
