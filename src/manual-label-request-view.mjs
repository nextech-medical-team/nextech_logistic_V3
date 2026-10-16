// Read-only acknowledgement of the actual persisted human request, not an order
// carrier choice and never proof that the provider accepted a purchase.
export function manualLabelRequestView(o){
 if(o.channel==='tender')return null;
 const r=o.resolution_active;
 if(typeof r?.id!=='string'||!r.id||r.action!=='choose-carrier'||!['queued','running','waiting'].includes(r.status)||!['gls','gofo'].includes(r.carrier))return null;
 const carrier=r.carrier.toUpperCase(),c=o.carrier_job;
 let state=r.status==='running'?'active':'queued';
 let message=r.status==='queued'?`Demande ${carrier} reçue · en attente de traitement`:r.status==='running'?`Demande ${carrier} en cours de traitement`:`Demande ${carrier} enregistrée · suivi du traitement`;
 if(r.status==='waiting'&&c?.batch_id==='resolution-'+r.id){
  if(c.status==='pending')message=`Création de l’étiquette ${carrier} en attente`;
  if(c.status==='creating'){state='active';message=`Création de l’étiquette ${carrier} en cours`;}
  if(c.status==='awaiting_pdf')message=`PDF ${carrier} en cours de récupération`;
  if(c.status==='ready'&&Number(o.document_count)>0){state='complete';message=`Étiquette ${carrier} disponible`;}
  if(['review','failed'].includes(c.status)){state='blocked';message=c.error||`Demande ${carrier} à vérifier`;}
 }
 return {id:r.id,carrier:r.carrier,status:r.status,state,message,received_at:r.created_at,updated_at:r.updated_at,supersedesLocalRefusal:!!o.label_diagnostic_history?.length&&c?.status==='failed'&&c.batch_id!=='resolution-'+r.id};
}
export function projectManualLabelRequest(o){
 const view=manualLabelRequestView(o);if(!view)return o;
 o.manual_label_request=view;
 o.label_manual_request_required=false;
 const timestamp=value=>value instanceof Date?value.getTime():Date.parse(value);
 const t=o.temu_job,at=timestamp(t?.state_since||t?.updated_at),received=timestamp(view.received_at);
 if(t?.status==='shipment_error'&&t.error&&Number.isFinite(at)&&Number.isFinite(received)&&at<=received){
  o.previous_temu_label_refusal={reason:t.error,at:t.state_since||t.updated_at};
  o.temu_job={...t,error:null};
 }
 return o;
}
