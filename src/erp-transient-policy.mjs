import {suspensionBlock} from './order-suspension.mjs';
import {shopifyCancellationReason} from './shopify-cancellation-policy.mjs';
export function cancellationBlock(o){
 const suspended=suspensionBlock(o);if(suspended)return suspended;
 const p=o.source_payload||{},t=p.temuOrderDetail?.parentOrderMap||{};
 if(o.channel==='shopify'&&(shopifyCancellationReason(p)||shopifyCancellationReason(p.marketplacePendingCorrection)))return 'Commande annulée ou entièrement remboursée : préparation suspendue';
 if([true,'true',1,'1'].includes(p.cancelled)||p.cancelled_at||Number(t.parentOrderStatus)===3||o.label_status==='cancelled'||o.tracking_status==='cancelled'||/commande annulée/i.test(o.issue||''))return 'Commande annulée : préparation suspendue';
 if(Array.isArray(t.parentOrderLabel)&&t.parentOrderLabel.some(x=>x.name==='pending_buyer_cancellation'&&Number(x.value)===1))return 'Demande d’annulation client en attente sur TEMU : préparation suspendue';
 return null;
}
export function transientErpError(message){return /SQLSTATE\[40001\]|\bdeadlock\b|lock wait timeout|Erplain HTTP (429|502|503|504)\b|fetch failed|ECONNRESET|ETIMEDOUT|timed out|TimeoutError|AbortError/i.test(message||'')}
export function mutationBlock(o,{allowHeldBc=false}={}){return !o||o.archived?'Commande indisponible':cancellationBlock(o)||(o.resolution_pending_resume&&!allowHeldBc?'Préparation suspendue : validation requise':null);}
export function retryDecision(o,error,updatedAt,now=Date.now()){
 const attempts=Number(o.erp_live?.transientRecovery?.attempts||0);
 const readLimited=o.erp_live?.transientRecovery?.readRateLimited===true&&/Erplain HTTP 429\b/.test(error||'');
 if(!transientErpError(error)||!Number.isInteger(attempts)||(attempts>=3&&!readLimited)||attempts<0)return false;
 if(o.archived||o.partial_mode||o.resolution_pending_resume||cancellationBlock(o)||Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection')||['shipped','delivered','in_transit'].includes(o.tracking_status))return false;
 if(['cancelled','closed'].includes(o.erp_live?.bc?.status)||['cancelled','closed'].includes(o.erp_live?.bl?.status))return false;
 const phase=o.erp_live?.phase;
 const initialRead=readLimited&&!phase&&!o.erp_live?.customer?.id&&!o.erp_live?.bc?.id&&!o.erp_live?.bl?.id;
 if(!initialRead&&!['creating_bc','bc_created','creating_bl','publishing_bl','bl_created','bl_ready','finalizing_bl'].includes(phase))return false;
 if(phase==='creating_bc'&&!o.erp_live?.customer?.id)return false;
 if(!initialRead&&phase!=='creating_bc'&&!o.erp_live?.bc?.id)return false;
 const retryAt=o.erp_live?.transientRecovery?.nextReadCheckAt;
 if(retryAt&&(!Number.isFinite(Date.parse(retryAt))||Date.parse(retryAt)>now))return false;
 return Number.isFinite(Date.parse(updatedAt))&&now-Date.parse(updatedAt)>=[30000,120000,300000][Math.min(attempts,2)];
}
