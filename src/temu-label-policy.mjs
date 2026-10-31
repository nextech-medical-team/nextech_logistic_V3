import {hasFailedTemuGlsApproval} from './temu-failed-label-gls.mjs';
export const temuLabelPolicyMessage="TEMU · Toute nouvelle étiquette doit être créée dans le parcours TEMU ; création directe GLS/GOFO interdite";
// Existing labels, tracking and PDFs remain available; this guard only rejects new creation.
export function assertDirectCarrierAllowed(order,carrier,{manualChoice=false}={}){
 if(order?.channel!=='temu')return;
 if(order.source_payload?.externalLabel?.active)throw Error('Étiquette externe enregistrée : aucun nouvel achat automatique');
 if(carrier==='gls'&&(manualChoice||order.transport_choice==='gls')&&hasFailedTemuGlsApproval(order))return;
 throw Error(temuLabelPolicyMessage);
}
