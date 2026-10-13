// Retire only local, unconfirmed previews. Never undo a provider mutation.
export async function abandonEquivalentPreview(db,{orderId,previewJobId,resolutionId}){
 return db.transaction(async tx=>{
  if(!(await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows.length)throw Error('Commande introuvable');
  const jobs=(await tx.query("SELECT * FROM resolution_jobs WHERE order_id=$1 AND action IN ('equivalent-preview','replace-equivalent') ORDER BY created_at DESC,id DESC FOR UPDATE",[orderId])).rows;
  const preview=jobs[0];
  if(!preview||preview.id!==previewJobId||preview.action!=='equivalent-preview'||!['complete','review'].includes(preview.status)||preview.payload?.substitutionAttempt||preview.result?.reconcileOnly)throw Error('Aperçu modifié ou remplacement à rapprocher : abandon non autorisé');
  if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND id<>$2 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM equivalence_import_rows r JOIN equivalence_imports i ON i.id=r.batch_id WHERE r.order_id=$1 AND i.status='applying'",[orderId,resolutionId])).rows.length)throw Error('Traitement en cours : attendre son résultat avant abandon');
  // Retire previous previews too, so the latest cannot reveal an older proposal.
  const retired=[];for(const job of jobs){if(job.action==='replace-equivalent')break;if(!['complete','review'].includes(job.status))continue;if(job.payload?.substitutionAttempt||job.result?.reconcileOnly)throw Error('Résultat de remplacement à rapprocher : abandon non autorisé');retired.push(job.id);}
  await tx.query("UPDATE resolution_jobs SET status='cancelled',stage='Aperçu abandonné explicitement',updated_at=now() WHERE order_id=$1 AND id=ANY($2::text[])",[orderId,retired]);
  return {readOnly:true,abandoned:true,retiredPreviewIds:retired,message:'Équivalent abandonné. Le produit original, le BC et les étiquettes existantes sont conservés. Vous pouvez ouvrir le problème de stock pour forcer l’étiquette.'};
 });
}
