// A failed write is never a retry authorization. Keep the exact upstream proof.
export function resolutionIncident(error,job){
 const detail=String(error?.message||error);
 const concurrency=/SQLSTATE\[?40001\]?|\bdeadlock\b|lock wait timeout/i.test(detail);
 const replacement=job.action==='replace-equivalent',suspended=job.replacementSuspended===true;
 if(!concurrency&&!suspended)return null;
 const b=job.payload||{},subject=replacement?'le remplacement '+String(b.sku||'du produit')+' → '+String(b.replacementSku||'du produit choisi'):'l’intervention';
 const message=(concurrency?'Incident de concurrence Erplain : '+subject+' n’est pas confirmé.':'Le résultat de '+subject+' reste à vérifier. '+detail)+
  (suspended?' La préparation reste suspendue. Relisez le BC et les BL avant toute reprise ; ne répétez pas l’enregistrement.':' Vérifiez le résultat avant de répéter cette intervention.');
 return {message,error:message,preparationSuspended:suspended,replacementPending:replacement,technicalIncident:{kind:concurrency?'erplain-concurrency':'replacement-result-unverified',detail,at:new Date().toISOString()}};
}

export async function suspendReplacement(db,orderId){
 await db.transaction(async tx=>{
  const order=(await tx.query('SELECT id,archived FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  if(!order||order.archived)throw Error('Commande absente ou archivée : remplacement interdit');
  const busy=(await tx.query("SELECT status FROM erp_live_jobs WHERE order_id=$1 AND status='processing' FOR UPDATE",[orderId])).rows;
  if(busy.length)throw Error('Traitement Erplain en cours : attendre avant le remplacement');
  await tx.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[orderId]);
 });
}
