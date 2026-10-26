import {readSubstitutionAttempt} from './substitution-attempt.mjs';
import {assertPartialShippingPreserved} from './partial-substitution-proof.mjs';
import {createHash} from 'node:crypto';
import {verifySubstitutionShipping} from './substitution-shipping-check.mjs';
import {readHistoricalStock,verifyHistoricalStock} from './historical-stock-proof.mjs';
import {substitutionExecutionSnapshot} from './substitution-execution-snapshot.mjs';
const signature=lines=>JSON.stringify([...lines.reduce((m,l)=>{
 const q=Number(l.quantity);if(!l.sku||!Number.isFinite(q)||q<=0)throw Error('Quantités du remplacement à rapprocher');
 m.set(l.sku,(m.get(l.sku)||0)+q);return m;
},new Map())].sort());
const sameRequest=(a,b)=>a&&a.scope===b.scope&&a.sku===b.sku&&a.replacementSku===b.replacementSku&&Number(a.replaceQuantity)===Number(b.replaceQuantity)&&Number(a.replacementQuantity)===Number(b.replacementQuantity);
const taxes=l=>Array.isArray(l.tax_codes)&&l.tax_codes.every(t=>t.id!=null)?JSON.stringify(l.tax_codes.map(t=>String(t.id)).sort()):null;
const commercialSnapshot=c=>JSON.stringify({id:String(c.id),status:c.status,update_stock:c.update_stock,total:c.total,tax_type:c.tax_type,currency:c.currency?.label,
 lines:c.line_items?.map(l=>({id:String(l.id),type:l.type,quantity:l.quantity,price:l.price,discount:l.discount,discount_rule_amount:l.discount_rule_amount,ecotax:l.ecotax,tax_amount:l.tax_amount,taxes:taxes(l),variant:l.variant?.id,sku:l.variant?.sku,location:l.location?.id})).sort((a,b)=>a.id.localeCompare(b.id))});
export function recordedSubstitutionPlan(bc,b,failed,preview,order={},historicalStock=null){
 if(failed?.status!=='review'||failed.payload?.confirmEquivalent!==true||!sameRequest(failed.payload,b)||preview?.status!=='complete'||!sameRequest(preview.payload,b)||preview.result?.previewFingerprint!==failed.payload.previewFingerprint)return null;
 const historical=String(failed.error||'').startsWith('Remplacement historique à rapprocher : ');
 const partial=String(failed.error||'').startsWith('Remplacement partiel à rapprocher : ');
 if(!historical&&!partial&&failed.error!=='Frais de livraison modifiés : rapprochement requis')return null;
 const blocked=()=>{throw Error('Remplacement déjà demandé : le BC doit être rapproché avant toute nouvelle modification. Aucune seconde écriture effectuée.');};
 const plan=preview.result,lines=bc?.line_items;
 if(partial){
  if(order.partial_mode!==true||!plan.partialProof||!plan.commercialBefore||plan.commercialBefore.update_stock!==false||String(plan.partialProof.bcId)!==String(bc?.id))return blocked();
  assertPartialShippingPreserved(plan.commercialBefore,bc);
  // A lost response must never result in a second replacement. Only an exact
  // unchanged product and shipment snapshot permits a new, confirmed preview.
  const stable=c=>JSON.stringify(substitutionExecutionSnapshot({id:String(c.id),status:c.status,update_stock:c.update_stock,lines:c.line_items?.map(l=>({...l,id:String(l.id)})).sort((a,b)=>a.id.localeCompare(b.id))}));
  if(stable(plan.commercialBefore)===stable(bc))return null;
 }

 if(historical){
  if(!plan.commercialBefore||plan.commercialBefore.update_stock!==true||plan.historicalStockProof?.stockOnBc!==true||String(plan.historicalStockProof.bcId)!==String(bc?.id))return blocked();
  verifyHistoricalStock(bc,historicalStock?.evidence);
  // A throttled historical replacement may have left the BC unchanged.
  // Only a fresh, exact commercial snapshot AND a reconciled stock ledger
  // permit a new preview. Applying it still requires its new fingerprint and
  // explicit confirmation; an already applied replacement uses recovery below.
  if(failed.error==='Remplacement historique à rapprocher : Erplain HTTP 429'&&commercialSnapshot(plan.commercialBefore)===commercialSnapshot(bc))return null;
 }
 if(b.scope!=='order'||String(plan.bcId)!==String(bc?.id)||bc.update_stock!==(historical?true:false)||!['active','pending','unpublished'].includes(bc.status)||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.data.length&&!partial||!Array.isArray(lines)||!Array.isArray(plan.items)||!Array.isArray(plan.expected))return blocked();
 if(lines.some(l=>!['normal','shipping_cost'].includes(l.type)||!l.id)||new Set(lines.map(l=>String(l.id))).size!==lines.length||lines.length!==plan.items.length)return blocked();
 if(signature(lines.filter(l=>l.type==='normal').map(l=>({sku:l.variant?.sku,quantity:l.quantity})))!==signature(plan.expected))return blocked();
 const used=new Set();
 for(const item of plan.items){
  const matching=lines.filter(l=>!used.has(String(l.id))&&(item.id?String(l.id)===String(item.id):l.type==='normal'&&String(l.variant?.id)===String(item.variant?.id)&&String(l.location?.id)===String(item.location?.id)));
  if(matching.length!==1)return blocked();
  const line=matching[0];if(Number(line.quantity)!==Number(item.quantity))return blocked();
  used.add(String(line.id));
 }
 if(plan.commercialBefore){
  verifySubstitutionShipping(plan.commercialBefore,bc);
  for(const item of plan.items.filter(i=>i.id)){const prior=plan.commercialBefore.line_items.find(l=>String(l.id)===String(item.id)),current=lines.find(l=>String(l.id)===String(item.id));if(!prior||!current||prior.type!==current.type||prior.type==='normal'&&(String(prior.variant?.id)!==String(current.variant?.id)||String(prior.location?.id)!==String(current.location?.id)))return blocked();}
 }
 return {...plan,reconcileOnly:true,recoveredFrom:failed.id,available:null,
  recoverySummary:'Le BC '+(bc.label||bc.id)+' contient déjà les produits et quantités du remplacement demandé. V3 peut être synchronisé sans réécrire le remplacement ni comparer les montants.',
  previewFingerprint:createHash('sha256').update(JSON.stringify(substitutionExecutionSnapshot({bc,failedId:failed.id,plan}))).digest('hex')};
}
export async function findRecordedSubstitution(db,o,b,bc,api){
 const failed=(await db.query("SELECT id,payload,status,coalesce(result->'technicalIncident'->>'detail',error) AS error,created_at FROM resolution_jobs WHERE order_id=$1 AND action='replace-equivalent' AND (request_id<>$2 OR payload ? 'substitutionAttempt') AND (payload ? 'substitutionAttempt' OR status='complete' OR error='Frais de livraison modifiés : rapprochement requis' OR error LIKE 'Remplacement historique à rapprocher : %' OR error LIKE 'Remplacement partiel à rapprocher : %' OR result->'technicalIncident'->>'detail' LIKE 'Remplacement historique à rapprocher : %' OR result->'technicalIncident'->>'detail' LIKE 'Remplacement partiel à rapprocher : %') ORDER BY created_at DESC LIMIT 1",[o.id,b.requestId||''])).rows[0];
 const attempt=readSubstitutionAttempt(failed,o);
 if(attempt){
  // A committed replacement can enter review when subsequent stock/BL checks
  // fail. Prove that replacement before allowing a different product to change.
  const nextProduct=attempt.phase==='local_committed'&&failed.payload.sku!==b.sku;
  if(failed.status!=='review'||!sameRequest(failed.payload,b)&&!nextProduct)throw Error('Rapprocher d’abord le remplacement interrompu enregistré sur ce BC, avant de choisir un autre produit.');
  if(bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||bc.line_items?.some(l=>l.type==='normal'&&(l.variant?.active!==true||l.variant?.product?.active!==true)))throw Error('Remplacement interrompu : contenu du BC incomplet ou modifié, rapprochement requis.');
  const request={...failed.payload,scope:'order'},body={...(nextProduct?failed.payload:b),scope:'order'};
  const recovery=recordedSubstitutionPlan(bc,body,{...failed,payload:request,status:'review',error:'Frais de livraison modifiés : rapprochement requis'},{payload:request,status:'complete',result:attempt.plan},o);
  if(!recovery)throw Error('Remplacement interrompu : résultat Erplain non confirmé, aucune seconde écriture autorisée.');
  delete recovery.localCommitted;delete recovery.completionResult;
  if(attempt.phase==='local_committed'){
   const rows=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
   if(o.erp_live?.equivalentAttemptId!==attempt.requestId||signature(rows.map(l=>({sku:l.target_sku||l.source_sku,quantity:l.target_quantity??l.quantity})))!==signature(recovery.expected)||!attempt.completionResult)throw Error('Synchronisation locale du remplacement à rapprocher.');
   recovery.localCommitted=true;recovery.completionResult=attempt.completionResult;
  }
  // Keep the prior preparation diagnosis; only permit a fresh preview here.
  if(nextProduct)return null;
  return {...recovery,recordedPermanent:attempt.permanent,recordedMappingBefore:attempt.mappingBefore,attemptRecovery:true};
 }
 const historical=String(failed?.error||'').startsWith('Remplacement historique à rapprocher : ');
 const partial=String(failed?.error||'').startsWith('Remplacement partiel à rapprocher : ');
 if(failed?.status==='review'&&(historical||partial||failed.error==='Frais de livraison modifiés : rapprochement requis')&&!sameRequest(failed.payload,b))throw Error('Rapprocher d’abord le remplacement déjà demandé sur ce BC, avant de choisir un autre produit.');
 if(failed?.status!=='review'||!sameRequest(failed.payload,b))return null;
 const preview=(await db.query("SELECT payload,status,result FROM resolution_jobs WHERE order_id=$1 AND action='equivalent-preview' AND status='complete' AND result->>'previewFingerprint'=$2 AND created_at<=$3 ORDER BY created_at DESC LIMIT 1",[o.id,failed.payload.previewFingerprint,failed.created_at])).rows[0];
 if((partial||historical)&&(!preview||preview.status!=='complete'||preview.result?.previewFingerprint!==failed.payload.previewFingerprint))throw Error('Aperçu du remplacement '+(partial?'partiel':'historique')+' absent : rapprochement requis avant toute nouvelle écriture.');
 const historicalStock=historical?await readHistoricalStock(api,bc,{additionalVariants:(preview?.result?.commercialBefore?.line_items||[]).filter(l=>l.type==='normal').map(l=>l.variant.id)}):null;
 return recordedSubstitutionPlan(bc,b,failed,preview,o,historicalStock);
}
