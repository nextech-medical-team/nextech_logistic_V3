import {createHash} from 'node:crypto';
const mismatch='GLS · Relais enregistré pour l’étiquette différent du choix Shopify : rapprocher avant remise';
const matched='GLS · Relais de l’étiquette désormais conforme : reprise à vérifier';
const removeOwn=(issue,hold)=>issue===hold?.reason?'':issue?.startsWith(hold?.reason+' | ')?issue.slice(hold.reason.length+3):issue||'';
export function relayLabelObservation(order,relay,job,documents){
 if(order.channel!=='shopify'||order.archived||order.label_status==='cancelled'||order.suspension?.active||order.suspension?.erplainCancellation||relay?.metadataComplete!==true||relay.reference!==order.reference||relay.sourceId!==String(order.source_payload?.id)||!relay?.selectedId||job?.status!=='ready'||job.environment!=='production'||job.carrier!=='gls'||!documents?.length)return null;
 const id=order.source_payload?.glsParcelShopId||order.source_payload?.glsParcelShop?.parcelShopId,hold=order.source_payload?.relayDestinationHold;
 if(!id)return {issue:'GLS · Relais de l’étiquette à rapprocher du choix Shopify',labelStatus:'blocked',record:{active:true,status:'label_id_unproven',selectedParcelShopId:relay.selectedId,existingLabelsPreserved:true}};
 if(id===relay.selectedId&&!hold?.active)return null;
 const sha256=createHash('sha256');for(const d of [...documents].sort((a,b)=>a.document_index-b.document_index)){sha256.update(String(d.document_index));sha256.update(d.pdf);}const pdfSha256=sha256.digest('hex');
 const reason=id===relay.selectedId?matched:mismatch,other=removeOwn(order.issue,hold);
 return {issue:reason+(other?' | '+other:''),labelStatus:'blocked',record:{active:id!==relay.selectedId,status:id===relay.selectedId?'matched_pending_review':'selected_mismatch',reason,labelParcelShopId:id,selectedParcelShopId:relay.selectedId,sourceVersion:relay.sourceVersion,observedAt:relay.observedAt,pdfSha256,existingLabelsPreserved:true}};
}
