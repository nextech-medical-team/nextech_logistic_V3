import {usesRecordedBc,readRecordedBc} from './existing-bc-execution.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';

// Deliberately excludes stock discrepancies, provider refusals, cancellation
// and uncertain mutation errors. Retire an entire reason only when recognized.
export function retiredCommercialControl(message){
 const text=String(message||'');
 if(/incertaine|à vérifier :|mouvement|sortie de stock|Écart BC\/BL/i.test(text))return false;
 return /^BC · (?:Base fiscale des prix Erplain différente ou absente|Produits ou quantités des lignes Erplain différents de la source|Codes TVA Erplain différents de la source ; produits et quantités identiques|Contrôle des (?:montants|remises et écotaxes) Erplain incomplet|Prix, remises ou écotaxes des lignes Erplain différents de la source|Montants source à récupérer avant préparation|Montant Erplain non reçu|Prix de ligne Erplain absent ou invalide|Montants des lignes source (?:incomplets|incohérents)|Somme des lignes source incohérente|Précision du prix Erplain non conforme|Prix source non relié à ses montants|Montant décimal source non relié à sa ligne|Remise ou écotaxe de ligne absente ou invalide|Total Erplain .+ différent du total source .+|TVA Erplain .+ différente de la TVA source .+)$/.test(text)
 || /^Commande V3 et (?:BC|livraison existante) différents? : (?:comparer les produits et quantités avant de générer l’étiquette|vérifier les produits et quantités avant reprise|vérifier les quantités avant (?:reprise|dérogation))$/.test(text);
}
export function postBcRecoveryEligible(o){
 return usesRecordedBc(o)&&retiredCommercialControl(o.error)&&!o.archived&&!String(o.reference||'').startsWith('DEMO-')&&!cancellationBlock(o)
 &&!o.partial_mode&&!o.source_payload?.visibilityHold&&!o.source_payload?.erplainValidationHold&&!o.resolution_pending_resume
 &&!['shipped','delivered','in_transit'].includes(o.tracking_status)
 &&!['creating_bc','creating_customer','creating_stock','creating_bl','publishing_bl','finalizing_bl'].includes(o.erp_live?.phase);
}
export async function retirePostBcCommercialControls(db,api,{orderId=null}={}){
 const rows=(await db.query(`SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id
 WHERE e.status='review' AND o.erp_live->'bc'->>'id' IS NOT NULL AND NOT o.archived
 AND (e.error LIKE 'BC · %' OR e.error LIKE 'Commande V3 et %')
 AND ($1::text IS NULL OR o.id=$1) ORDER BY e.updated_at`,[orderId])).rows;
 const results=[];
 let attempted=0;for(const o of rows){
  if(!postBcRecoveryEligible(o))continue;
  if(attempted++>=25)break;
  await api.verify?.();
  // Provider calls are query-only: never repair or rewrite the commercial BC.
  const reader={request:(q,v)=>{if(!/^query\s/.test(q))throw Error('Lecture BC uniquement');return api.request(q,v);}};
  let execution;try{execution=await readRecordedBc(reader,o);}catch{continue;}
  if(execution.bc.status!=='active')continue;
  const result=await db.transaction(async tx=>{
   const fresh=(await tx.query("SELECT o.*,e.error FROM orders o JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.id=$1 AND e.status='review' FOR UPDATE OF o,e",[o.id])).rows[0];
   if(!fresh||!postBcRecoveryEligible(fresh)||fresh.error!==o.error||JSON.stringify(fresh.erp_live)!==JSON.stringify(o.erp_live))return {updated:false};
   if((await tx.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')",[o.id])).rows.length)return {updated:false};
   const checkedAt=new Date().toISOString(),record={previousError:o.error,checkedAt,bcId:String(execution.bc.id),policy:'recorded-bc-no-commercial-comparison',providerMutations:0,labelsPreserved:true};
   const state={...fresh.erp_live,bc:{...fresh.erp_live.bc,...execution.bc},pricing:execution.pricing,postBcControlRetired:record};
   await tx.query("UPDATE resolution_jobs SET error=null,result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||$3::jsonb,updated_at=now() WHERE order_id=$1 AND status='review' AND action IN ('resume','resume-erp','reconcile-bc','compare-bc') AND error=$2",[o.id,o.error,JSON.stringify({postBcCommercialControlRetired:record})]);
   await tx.query('UPDATE orders SET erp_live=$2::jsonb,issue=CASE WHEN issue=$3 THEN NULL ELSE issue END WHERE id=$1',[o.id,JSON.stringify(state),o.error]);
   await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:post-bc-policy','erplain.commercial_control_retired',$1)",[JSON.stringify({orderId:o.id,...record})]);
   return {updated:true,orderId:o.id,...record};
  });results.push(result);
 }return results;
}
