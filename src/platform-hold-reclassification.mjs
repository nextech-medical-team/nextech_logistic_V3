import {createHash} from 'node:crypto';
import {marketplaceChanged} from './marketplace-comparison.mjs';
import {planPlatformShipmentHold} from './platform-shipment-hold-plan.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)??'undefined').digest('hex');
const diagnostic=/^Commande (?:déjà expédiée dans (?:Shopify|Amazon)(?: · Vérifier les documents)?|(?:entièrement remboursée|annulée) dans Shopify(?: · BC et BL Erplain annulés)?)$/i;
// Retain independent operational holds. Only replace their outdated platform reason.
export function planPlatformHoldReconciliation(evidence,{now=Date.now(),maxAgeMs=300000}={}){
 const plan=planPlatformShipmentHold(evidence,{now,maxAgeMs});if(plan.eligible)return plan;
 const {order,sourceRead,normalizedIncoming,priorLines,otherErrors=[],runtimeProof}=evidence;
 if(!order||!diagnostic.test(order.issue||''))return plan;
 if(order.archived||order.suspension?.active||order.suspension?.erplainCancellation)return {...plan,code:'business_suspension',reason:'Archive ou suspension humaine conservée'};
 const at=Date.parse(sourceRead?.checkedAt),pausedAt=Date.parse(runtimeProof?.checkedAt);
 if(sourceRead?.readOnly!==true||sourceRead?.complete!==true||sourceRead?.origin!=='provider'||sourceRead?.channel!==order.channel||sourceRead?.orderId!==order.id||!Number.isFinite(at)||at>now||now-at>maxAgeMs)return {...plan,code:'source_unverified'};
 if(!sourceRead.payload||!normalizedIncoming?.source_payload||!Object.keys(sourceRead.payload).every(k=>hash(sourceRead.payload[k])===hash(normalizedIncoming.source_payload[k]))||normalizedIncoming.reference!==order.reference||String(sourceRead.payload.id)!==String(order.source_payload?.id))return {...plan,code:'source_identity'};
 let reason;
 const bc=order.erp_live?.bc,bl=order.erp_live?.bl;
 if(['cancelled','closed'].includes(bc?.status)||['cancelled','closed'].includes(bl?.status))reason=[['BC',bc],['BL',bl]].filter(([,d])=>['cancelled','closed'].includes(d?.status)).map(([name,d])=>name+' '+(d.status==='cancelled'?'annulé':'clos')+' dans Erplain').join(' · ')+' · reprise à vérifier';
 else if(marketplaceChanged(order,priorLines,normalizedIncoming))reason='Commande modifiée sur la plateforme · articles, quantités ou adresse à rapprocher';
 else if(otherErrors.length)reason='Préparation V3 à vérifier · '+otherErrors.map(String).join(' · ').slice(0,450);
 else return plan;
 const source_payload={...order.source_payload,platformStatusObservation:{payload:sourceRead.payload,version:sourceRead.payload.updated_at||null,observedAt:sourceRead.checkedAt,indicative:true},platformHoldReclassification:{checkedAt:sourceRead.checkedAt,previousReason:order.issue,reason,operationalStatePreserved:true}};
 return {eligible:true,executionAllowed:false,classification:'independent_problem_preserved',lifecycleRevisionChanged:false,technicalPatch:{source_payload,issue:reason,resolution_pending_resume:order.resolution_pending_resume,label_status:order.label_status},newJobs:[],externalCalls:[],writerPauseProven:runtimeProof?.allBusinessWritersPaused===true&&Number.isFinite(pausedAt)&&pausedAt<=now&&now-pausedAt<=maxAgeMs};
}
