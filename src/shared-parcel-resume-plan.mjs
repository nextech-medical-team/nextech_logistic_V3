export const sharedParcelResumeReason='Colis partagé entre plusieurs commandes';
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const timestamp=x=>x instanceof Date?x.getTime():Date.parse(x);
export function planSharedParcelResume({members,registry,checkedAt},now=Date.now()){
 const no=reason=>({eligible:false,reason});
 if(!Array.isArray(members)||members.length<2||members.length>10)return no('group_scope');
 const ids=members.map(x=>x.order?.id),refs=members.map(x=>x.order?.reference);
 if(ids.some(x=>!x)||new Set(ids).size!==ids.length||refs.some(x=>!x)||new Set(refs).size!==refs.length)return no('group_identity');
 if(!/^PK-\d+$/.test(registry?.package||'')||registry.labelStatus!==1||!registry.tracking||registry.failure||!Array.isArray(registry.orderReferences)||JSON.stringify([...new Set(registry.orderReferences)].sort())!==JSON.stringify([...refs].sort()))return no('current_package_unverified');
 const at=timestamp(checkedAt);if(!Number.isFinite(at)||at>now||now-at>300000)return no('proof_expired');
 const patches=[],proofMembers=[];
 for(const m of members){
  const o=m.order||{},s=o.erp_live||{},e=m.erpProof||{},resume=m.latestResume||{};
  if(o.channel!=='temu'||o.archived||o.duplicate_of||o.partial_mode||o.suspension?.active===true||o.suspension?.erplainCancellation||o.tracking_status==='cancelled'||o.label_status!=='blocked'||o.resolution_pending_resume!==true||o.issue!==sharedParcelResumeReason)return no('order_scope');
  if(m.busy||!Array.isArray(m.otherErrors)||m.otherErrors.length||s.documentSource?.stockHolds?.length||s.stockCreationAttemptedAt||s.mappingAlignmentAttempt?.status==='uncertain')return no('independent_blocker');
  if(s.phase!=='bl_ready'||m.erpJob?.status!=='complete'||m.erpJob.error!==null||resume.action!=='resume-erp'||resume.status!=='complete'||resume.error!==null||resume.result?.resume!==true||resume.result?.erpOnly!==true||resume.result?.regenerateExisting===true)return no('completed_resume_unverified');
  const verification=resume.result.statusVerification;
  const technicalOnly=new Set(['Reprise de préparation à vérifier','Préparation bloquée à vérifier']);
  if(!verification||verification.source!=='current-local-diagnostics'||verification.state!=='needs_review'||!Array.isArray(verification.blockers)||verification.blockers.length!==2||new Set(verification.blockers).size!==2||verification.blockers.some(x=>!technicalOnly.has(x)))return no('resume_verification_unverified');
  const completed=timestamp(resume.updated_at),erpAt=timestamp(m.erpJob.updated_at),ready=timestamp(s.bl?.readyConfirmedAt);
  if([completed,erpAt,ready].some(x=>!Number.isFinite(x)||x>now)||completed<ready||erpAt<ready)return no('completion_date_unverified');
  if(!same(e.bc?.id,s.bc?.id)||e.bc.status!=='active'||e.bc.externalReference!==o.reference||e.bc.updateStock!==true||e.shippingConnectionComplete!==true||!Array.isArray(e.bls)||e.bls.length!==1)return no('current_bc_unverified');
  const bl=e.bls[0];if(!same(bl.id,s.bl?.id)||!['ready_to_ship','shipped','delivered','completed'].includes(bl.status)||bl.externalReference!==o.reference||bl.updateStock!==true)return no('current_bl_unverified');
  const history=s.historicalStockProof;
  if(!same(history?.bcId,s.bc?.id)||history.stockOnBc!==true||!Array.isArray(history.logIds)||!history.logIds.length||e.noAdditionalStockRemoval!==true||e.ledgerComplete!==true||e.savedEventsStillPresent!==true||JSON.stringify([...history.logIds].map(String).sort())!==JSON.stringify([...(e.savedHistoricalEvents||[])].map(String).sort()))return no('stock_history_unverified');
  const j=m.labelJob,l=m.label;
  if(j?.status!=='complete'||j.error!==null||j.source!=='temu_direct'||!Array.isArray(j.packages)||j.packages.length!==1||j.packages[0]!==registry.package||l?.package!==registry.package||!(l.bytes>0)||l.signature!=='%PDF-'||!/^[a-f0-9]{64}$/.test(l.rawSha256||''))return no('existing_label_unverified');
  const key='preserved:temu:'+o.reference+':'+registry.package;
  const copy=m.copies?.find(x=>x.document_key===key);
  if(!copy||copy.source_hash!==l.rawSha256||!(copy.bytes>0)||!/^[a-f0-9]{64}$/.test(copy.servedSha256||''))return no('printed_copy_unverified');
  patches.push({id:o.id,issue:null,resolution_pending_resume:false,label_status:'production_ready'});
  proofMembers.push({id:o.id,reference:o.reference,bcId:String(s.bc.id),blId:String(bl.id),resumeId:resume.id,stockEventIds:history.logIds.map(String),rawSha256:l.rawSha256,printedCopyId:copy.id,printedCopySha256:copy.servedSha256});
 }
 if(new Set(members.map(x=>x.label.rawSha256)).size!==1)return no('shared_pdf_unverified');
 return {eligible:true,patches,proof:{checkedAt,package:registry.package,tracking:registry.tracking,members:proofMembers,providerWrites:0,newJobs:[],documentsModified:0,labelsModified:0,businessCompleted:false}};
}
