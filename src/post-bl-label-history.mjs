import {hasCreatedBl} from './created-bl-label.mjs';

// Exact obsolete local refusals only; never infer a successful shipment.
export const retiredPostBlLabelReasons=[
 'Mapping modifié avant création : recontrôle requis',
 'Mapping modifié depuis la validation du BL : recontrôle requis',
 'BC modifié depuis sa préparation : recontrôle requis',
 'Préparation modifiée depuis la validation du BL : actualiser la préparation du transport avant étiquette.',
 'Préparation modifiée depuis la validation du BL : recontrôler les quantités et le transport avant étiquette.',
 'Validation de la préparation à actualiser avant étiquette.',
 'Étiquette bloquée : contrôle du stock et BL validé requis.'
];
export function projectPostBlLabelHistory(o){
 const c=o.carrier_job;
 if(!hasCreatedBl(o)||o.archived||o.duplicate_of||o.partial_mode||o.label_status==='cancelled'||o.source_payload?.externalLabel?.active||o.suspension?.active||o.suspension?.erplainCancellation||o.erp_live?.bc?.status==='cancelled'||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))return o;
 if(c?.status!=='failed'||c.result||c.hasResult||c.reference||c.creation_started_at||c.failure_phase==='provider'||c.stock_override||!Array.isArray(c.tracking)||c.tracking.length||c.documentCount>0||Number(o.document_count)>0)return o;
 if(!retiredPostBlLabelReasons.includes(c.error))return o;
 const reasons=new Set(retiredPostBlLabelReasons),history=[...(o.label_diagnostic_history||[])];
 for(const [target,key,source] of [[c,'error','carrier'],[o,'resolution_error','resolution'],[o,'issue','order'],...(o.resolution_actions||[]).map(j=>[j,'error','resolution:'+j.id])]){
  if(target&&reasons.has(target[key])){
   const entry={source,reason:target[key],at:target.updated_at||o.resolution_error_updated_at||null};
   if(!history.some(h=>h.source===entry.source&&h.reason===entry.reason&&h.at===entry.at))history.push(entry);
   target[key]=null;
  }
 }
 o.label_diagnostic_history=history;
 o.label_manual_request_required=true;
 return o;
}
