export function receiptOutcome(run,rows){
 const result={complete:run.plan?.coverage?.complete===true,finalized:[],unfinished:[],existing:[],excluded:[]};
 for(const row of rows){
  const bl=row.currentBl||(row.bls?.length===1?row.bls[0]:null),entry={id:row.id,reference:row.reference,bl:bl?.label||null,labels:row.labels||[]};
  if(row.work==='history'){result.excluded.push({...entry,reason:'Commande annulée, archivée ou déjà expédiée'});continue;}
  if(row.documentsComplete){(row.item?result.finalized:result.existing).push(entry);continue;}
  const stage=!bl?.id?'BL non disponible':!row.labels?.length?'BL disponible, étiquette manquante':'BL disponible, documents de tous les colis non confirmés';
  result.unfinished.push({...entry,stage,reason:row.item?.error||row.item?.job?.error||row.labelError||row.reason||'Traitement non terminé',action:row.channel==='temu'&&bl?.id&&!row.labels?.length?'Obtenir ou récupérer l’étiquette dans TEMU':row.item?.job?.stage||'Examiner le motif puis reprendre l’étape concernée'});
 }
 return result;
}
