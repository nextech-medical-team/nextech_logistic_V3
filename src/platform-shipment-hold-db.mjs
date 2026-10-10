import {createHash} from 'node:crypto';
import {platformLifecycleRevisionSql} from './platform-lifecycle-revision.mjs';
export function platformLifecycleReadinessProblem(order,existing,partials,now){
 if(!existing.length||existing.some(l=>l.locked||l.requested||l.error||!Number.isFinite(Date.parse(l.checked_at))||Date.parse(l.checked_at)>now||now-Date.parse(l.checked_at)>=21600000))return 'Statut BL Erplain à rapprocher · actualisation demandée, en erreur ou échue';
 const expectedIds=[order?.erp_live?.bl?.id,...partials.map(p=>p.bl?.id)].filter(x=>x!=null).map(String);
 if(!expectedIds.length||expectedIds.some(bl=>!existing.some(l=>String(l.bl_id)===bl)))return 'Statut BL Erplain à rapprocher · document absent du contrôle lifecycle';
 return null;
}
// The pause probe must inspect authoritative stopped/idle writer state.
// This factory does not stop services or invoke any provider.
export function platformHoldDatabaseAdapter({sourceRead,normalizedIncoming,partialAllocationProof,pauseProbe,now=()=>Date.now()}){
 if(typeof pauseProbe!=='function')throw Error('Sonde de pause intégrée requise');
 const paused=async()=>{const p=await pauseProbe();if(p?.paused!==true||!p.epoch)throw Error('Writers non arrêtés');return p;};
 return {assertWritersPaused:paused,
 async readLockedEvidence(tx,id){
  const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!order)throw Error('Commande introuvable');
  const rows={};
  for(const table of ['lines','jobs','erp_live_jobs','carrier_jobs','carrier_documents','document_lifecycle','extra_parcels','partial_deliveries','resolution_jobs','correction_jobs'])rows[table]=(await tx.query(`SELECT * FROM ${table} WHERE order_id=$1 FOR UPDATE`,[id])).rows;
  rows.partial_documents=rows.partial_deliveries.length?(await tx.query('SELECT d.* FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 ORDER BY d.delivery_id,d.document_index FOR UPDATE OF d',[id])).rows:[];
  rows.carrier_documents.sort((a,b)=>a.document_index-b.document_index);
  const labels=rows.carrier_documents.map(d=>({orderId:id,index:d.document_index,tracking:rows.carrier_jobs[0]?.tracking?.[d.document_index],sha256:createHash('sha256').update(d.pdf).digest('hex')}));
  const carrierJobs=[...rows.carrier_jobs];
  const activeExtras=rows.extra_parcels.filter(p=>!['failed','cancelled'].includes(p.status)).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const invalidExtras=[];
  for(const extra of activeExtras){
   if(extra.status!=='ready'||extra.error||!extra.pdf||typeof extra.tracking!=='string'||!extra.tracking.trim()){invalidExtras.push(extra.id);continue;}
   carrierJobs.push({status:extra.status,error:extra.error,environment:extra.environment,tracking:[extra.tracking],carrier:extra.carrier,evidenceId:extra.id});
   labels.push({orderId:id,index:labels.length,tracking:extra.tracking,sha256:createHash('sha256').update(extra.pdf).digest('hex'),parcelId:extra.id,documentIndex:extra.parcel_index});
  }
  const invalidPartials=[];
  for(const partial of [...rows.partial_deliveries].sort((a,b)=>String(a.id).localeCompare(String(b.id)))){
   const docs=rows.partial_documents.filter(d=>d.delivery_id===partial.id).sort((a,b)=>a.document_index-b.document_index);
   if(partial.status!=='ready'||partial.error||!Array.isArray(partial.tracking)||!partial.tracking.length||docs.length!==partial.tracking.length||docs.some((d,i)=>d.document_index!==i||!d.pdf)){invalidPartials.push(partial.id);continue;}
   const newTracking=[];
   for(const d of docs){const tracking=partial.tracking[d.document_index],sha256=createHash('sha256').update(d.pdf).digest('hex'),prior=labels.find(l=>l.tracking===tracking);
    if(prior){const priorJob=carrierJobs.find(j=>j.tracking?.includes(tracking));if(prior.sha256!==sha256||priorJob?.environment!==partial.environment||priorJob?.carrier!==partial.carrier)invalidPartials.push(partial.id);continue;}
    newTracking.push(tracking);labels.push({orderId:id,index:labels.length,tracking,sha256,deliveryId:partial.id,documentIndex:d.document_index});
   }
   if(newTracking.length)carrierJobs.push({status:partial.status,error:partial.error,environment:partial.environment,carrier:partial.carrier,tracking:newTracking,evidenceId:partial.id});
  }
  rows.partial_documents=rows.partial_documents.map(({pdf,...d})=>({...d,pdfSha256:pdf?createHash('sha256').update(pdf).digest('hex'):null}));
  // Keep cancelled/failed historical PDF hashes too, without treating them as active parcels.
  rows.extra_parcels=rows.extra_parcels.map(({pdf,...p})=>({...p,pdfSha256:pdf?createHash('sha256').update(pdf).digest('hex'):null}));
  const relatedEvidence=Object.fromEntries(Object.entries(rows).filter(([k])=>k!=='carrier_documents'));relatedEvidence.documentHashes=labels;
  const otherErrors=[];
  for(const key of ['resolution_jobs','correction_jobs'])for(const job of rows[key].filter(j=>j.status!=='complete'||j.error))otherErrors.push(job.error||key+' à rapprocher');
  if(order.resolution_error)otherErrors.push(order.resolution_error);
  if(invalidExtras.length)otherErrors.push('Colis supplémentaires non confirmés ou sans PDF');
  if(invalidPartials.length)otherErrors.push('Livraison partielle non confirmée ou documents ambigus');
  if(rows.partial_deliveries.length&&!partialAllocationProof)otherErrors.push('Allocation BC/BL partielle non prouvée');
  const lifecycleProblem=platformLifecycleReadinessProblem(order,rows.document_lifecycle,rows.partial_deliveries,now());if(lifecycleProblem)otherErrors.push(lifecycleProblem);
  const p=await paused();
  return {order,priorLines:rows.lines,sourceRead,normalizedIncoming,labels,carrierJobs,workflowJobs:rows.jobs,erpJobs:rows.erp_live_jobs,otherErrors,partialAllocationProof,relatedEvidence,runtimeProof:{allBusinessWritersPaused:true,checkedAt:new Date(now()).toISOString(),epoch:p.epoch}};
 },
 async pinLifecycleRevision(tx,id){
  const existing=(await tx.query('SELECT * FROM document_lifecycle WHERE order_id=$1 FOR UPDATE',[id])).rows;
  const currentOrder=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const partials=(await tx.query('SELECT * FROM partial_deliveries WHERE order_id=$1 FOR UPDATE',[id])).rows;
  const lifecycleProblem=platformLifecycleReadinessProblem(currentOrder,existing,partials,now());if(lifecycleProblem)throw Error(lifecycleProblem);
  const revisions=(await tx.query(platformLifecycleRevisionSql,[id])).rows;
  if(revisions.length!==existing.length||new Set(revisions.map(r=>r.bl_id)).size!==existing.length||revisions.some(r=>!r.revision||!existing.some(l=>l.bl_id===r.bl_id)))throw Error('Révision lifecycle incomplète');
  for(const r of revisions){const changed=await tx.query('UPDATE document_lifecycle SET preparation_revision=$2 WHERE bl_id=$1 RETURNING bl_id',[r.bl_id,r.revision]);if(changed.rows.length!==1)throw Error('Lifecycle disparu');}
  return {processingRequested:false,allDocumentsCovered:true};
 }};
}
