import {readSubstitutionAttempt} from './substitution-attempt.mjs';
import {assertPartialShippingPreserved} from './partial-substitution-proof.mjs';
import {createHash} from 'node:crypto';
import {verifySubstitutionShipping} from './substitution-shipping-check.mjs';
import {readHistoricalStock,verifyHistoricalStock} from './historical-stock-proof.mjs';
import {proveLegacyCurrentSource} from './legacy-current-source-proof.mjs';
const signature=lines=>JSON.stringify([...lines.reduce((m,l)=>{
 const q=Number(l.quantity);if(!l.sku||!Number.isFinite(q)||q<=0)throw Error('Quantités du remplacement à rapprocher');
 m.set(l.sku,(m.get(l.sku)||0)+q);return m;
},new Map())].sort());
const sameRequest=(a,b)=>a&&a.scope===b.scope&&a.sku===b.sku&&a.replacementSku===b.replacementSku&&Number(a.replaceQuantity)===Number(b.replaceQuantity)&&Number(a.replacementQuantity)===Number(b.replacementQuantity);
const taxes=l=>Array.isArray(l.tax_codes)&&l.tax_codes.every(t=>t.id!=null)?JSON.stringify(l.tax_codes.map(t=>String(t.id)).sort()):null;
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
  // unchanged commercial snapshot permits building a new, confirmed preview.
  const stable=c=>JSON.stringify({id:String(c.id),status:c.status,update_stock:c.update_stock,total:c.total,tax_type:c.tax_type,currency:c.currency?.label,
   lines:c.line_items?.map(l=>({id:String(l.id),type:l.type,quantity:l.quantity,price:l.price,discount:l.discount,discount_rule_amount:l.discount_rule_amount,ecotax:l.ecotax,tax_amount:l.tax_amount,taxes:taxes(l),variant:l.variant?.id,location:l.location?.id})).sort((a,b)=>a.id.localeCompare(b.id))});
  if(stable(plan.commercialBefore)===stable(bc))return null;
 }

 if(historical){
  if(!plan.commercialBefore||plan.commercialBefore.update_stock!==true||plan.historicalStockProof?.stockOnBc!==true||String(plan.historicalStockProof.bcId)!==String(bc?.id))return blocked();
  verifyHistoricalStock(bc,historicalStock?.evidence);
 }
 if(b.scope!=='order'||String(plan.bcId)!==String(bc?.id)||bc.update_stock!==(historical?true:false)||!['active','pending','unpublished'].includes(bc.status)||bc.tax_type!=='exclusive'||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.data.length&&!partial||!Array.isArray(lines)||!Array.isArray(plan.items)||!Array.isArray(plan.expected))return blocked();
 if(lines.some(l=>!['normal','shipping_cost'].includes(l.type)||!l.id)||new Set(lines.map(l=>String(l.id))).size!==lines.length||lines.length!==plan.items.length)return blocked();
 if(signature(lines.filter(l=>l.type==='normal').map(l=>({sku:l.variant?.sku,quantity:l.quantity})))!==signature(plan.expected))return blocked();
 const used=new Set();
 for(const item of plan.items){
  const matching=lines.filter(l=>!used.has(String(l.id))&&(item.id?String(l.id)===String(item.id):l.type==='normal'&&String(l.variant?.id)===String(item.variant?.id)&&String(l.location?.id)===String(item.location?.id)));
  if(matching.length!==1)return blocked();
  const line=matching[0];if(Number(line.quantity)!==Number(item.quantity))return blocked();
  if(item.price!==undefined&&(!Number.isFinite(Number(line.price))||Math.abs(Number(line.price)-Number(item.price))>1e-7))return blocked();
  if(!item.id&&(taxes(line)===null||taxes(line)!==taxes(item)))return blocked();
  used.add(String(line.id));
 }
 const shipping=lines.filter(l=>l.type==='shipping_cost');
 if(lines.some(l=>l.price==null||l.tax_amount==null||!Number.isFinite(Number(l.price))||!Number.isFinite(Number(l.tax_amount))||Number(l.price)<0||Number(l.tax_amount)<0))return blocked();
 const money=v=>new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
 const fees=shipping.reduce((n,l)=>n+Number(l.price)*Number(l.quantity),0);
 if(!Number.isFinite(fees)||bc.total==null||!Number.isFinite(Number(bc.total))||!bc.currency?.label)return blocked();
 const cents=v=>Math.round(Number(v)*100);
 const taxTotal=lines.reduce((n,l)=>n+Number(l.tax_amount),0);
 if(plan.commercialBefore){
  verifySubstitutionShipping(plan.commercialBefore,bc);
  // Retained products must match individually, not only the combined total.
  for(const item of plan.items.filter(i=>i.id)){
   const prior=plan.commercialBefore.line_items.find(l=>String(l.id)===String(item.id));
   const current=lines.find(l=>String(l.id)===String(item.id));
   if(!prior||!current||prior.type!==current.type)return blocked();
   if(prior.type==='normal'){
    const net=Number(prior.price)-(plan.commercialBefore.tax_type==='inclusive'?Number(prior.tax_amount)/Number(prior.quantity):0);
    if(String(prior.variant?.id)!==String(current.variant?.id)||String(prior.location?.id)!==String(current.location?.id)||!Number.isFinite(net)||Math.abs(net-Number(current.price))>1e-7||taxes(prior)!==taxes(current))return blocked();
   }
  }
  if(cents(plan.commercialBefore.total)!==cents(bc.total)||cents(plan.commercialBefore.line_items.reduce((n,l)=>n+Number(l.tax_amount),0))!==cents(taxTotal))return blocked();
 }else{
  // Old previews did not save shipping amounts. A single shipping line can be
  // reconstructed only from a prior Erplain-confirmed total/tax and fully priced
  // replacement products. Never infer an unpriced retained product's value.
  const pricing=order.erp_live?.pricing,review=order.erp_live?.commercialToleranceReview,attempted=Date.parse(failed.created_at);
  const proofs=[{confirmed:pricing?.confirmed,checkedAt:pricing?.verifiedAt}];
  // A routine refresh can replace pricing.verifiedAt after the failed attempt.
  // Retain a dated prior Erplain proof only when tied to the same source totals.
  if(review?.status==='accepted'&&review.confirmed?.sourceTotal!=null&&review.confirmed?.sourceTax!=null&&pricing?.total!=null&&pricing?.tax!=null&&cents(review.confirmed.sourceTotal)===cents(pricing.total)&&cents(review.confirmed.sourceTax)===cents(pricing.tax))proofs.push({confirmed:review.confirmed,checkedAt:review.checkedAt});
  const proof=proofs.find(p=>{const c=p.confirmed,checked=Date.parse(p.checkedAt);return c&&c.total!=null&&c.tax!=null&&c.authority==='erplain'&&Number.isFinite(checked)&&Number.isFinite(attempted)&&checked<=attempted&&Number.isFinite(Number(c.total))&&Number.isFinite(Number(c.tax))&&cents(c.total)===cents(bc.total)&&cents(c.tax)===cents(taxTotal);});
  const c=proof?.confirmed;
  if(!c||pricing?.currency!==bc.currency.label||shipping.length!==1||!Number.isFinite(taxTotal))return blocked();
  if(plan.items.filter(i=>i.id).some(i=>String(i.id)!==String(shipping[0].id)))return blocked();
  const productNet=plan.items.filter(i=>!i.id).reduce((n,i)=>n+Number(i.price)*Number(i.quantity),0);
  if(!Number.isFinite(productNet)||Math.abs(Number(c.total)-Number(c.tax)-productNet-fees)>1e-7)return blocked();
 }
 return {...plan,reconcileOnly:true,recoveredFrom:failed.id,available:null,
  recoverySummary:'Le BC '+(bc.label||bc.id)+' contient déjà le remplacement demandé : '+plan.expected.map(l=>l.sku+' × '+l.quantity).join(', ')+'. Total actuel : '+money(Number(bc.total))+' '+bc.currency.label+' ; frais de livraison HT : '+money(fees)+' '+bc.currency.label+'. Après confirmation, V3 sera synchronisé avec ce BC, sans nouvelle modification Erplain. Le stock et le BL seront ensuite contrôlés ; l’étiquette sera créée automatiquement si aucune étiquette n’existe déjà.',
  previewFingerprint:createHash('sha256').update(JSON.stringify({bc,failedId:failed.id,plan})).digest('hex')};
}
export async function findRecordedSubstitution(db,o,b,bc,api){
 const failed=(await db.query("SELECT id,payload,status,error,created_at FROM resolution_jobs WHERE order_id=$1 AND action='replace-equivalent' AND (request_id<>$2 OR payload ? 'substitutionAttempt') AND (payload ? 'substitutionAttempt' OR status='complete' OR error='Frais de livraison modifiés : rapprochement requis' OR error LIKE 'Remplacement historique à rapprocher : %' OR error LIKE 'Remplacement partiel à rapprocher : %') ORDER BY created_at DESC LIMIT 1",[o.id,b.requestId||''])).rows[0];
 const attempt=readSubstitutionAttempt(failed,o);
 if(attempt){
  const nextLine=!sameRequest(failed.payload,b);
  const blockedNext=()=>{throw Error('Rapprocher d’abord le remplacement interrompu enregistré sur ce BC, avant de choisir un autre produit.');};
  if(failed.status!=='review')return blockedNext();
  // A stock refusal on another line is not an uncertain replacement. Prove
  // both committed copies before allowing the ordinary preview of that line.
  if(nextLine&&(attempt.phase!=='local_committed'||failed.payload.scope!=='order'||b.scope!=='order'||attempt.permanent!==null||o.partial_mode||b.sku===failed.payload.sku||b.sku===failed.payload.replacementSku||!String(failed.error||'').startsWith('BL bloqué — stock insuffisant : ')))return blockedNext();
  if(bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||bc.line_items?.some(l=>Number(l.discount)||Number(l.discount_rule_amount)||Number(l.ecotax)||l.type==='normal'&&(l.variant?.active!==true||l.variant?.product?.active!==true)))throw Error('Remplacement interrompu : contenu du BC incomplet ou modifié, rapprochement requis.');
  const request={...failed.payload,scope:'order'},body={...(nextLine?failed.payload:b),scope:'order'};
  const recovery=recordedSubstitutionPlan(bc,body,{...failed,payload:request,status:'review',error:'Frais de livraison modifiés : rapprochement requis'},{payload:request,status:'complete',result:attempt.plan},o);
  if(!recovery)throw Error('Remplacement interrompu : résultat Erplain non confirmé, aucune seconde écriture autorisée.');
  delete recovery.localCommitted;delete recovery.completionResult;
  if(attempt.phase==='local_committed'){
   const rows=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
   if(o.erp_live?.equivalentAttemptId!==attempt.requestId||signature(rows.map(l=>({sku:l.target_sku||l.source_sku,quantity:l.target_quantity??l.quantity})))!==signature(recovery.expected)||!attempt.completionResult)throw Error('Synchronisation locale du remplacement à rapprocher.');
   recovery.localCommitted=true;recovery.completionResult=attempt.completionResult;
  }
  if(nextLine)return null;
  return {...recovery,recordedPermanent:attempt.permanent,recordedMappingBefore:attempt.mappingBefore,attemptRecovery:true};
 }
 const historical=String(failed?.error||'').startsWith('Remplacement historique à rapprocher : ');
 const partial=String(failed?.error||'').startsWith('Remplacement partiel à rapprocher : ');
 if(failed?.status==='review'&&(historical||partial||failed.error==='Frais de livraison modifiés : rapprochement requis')&&!sameRequest(failed.payload,b))throw Error('Rapprocher d’abord le remplacement déjà demandé sur ce BC, avant de choisir un autre produit.');
 if(failed?.status!=='review'||!sameRequest(failed.payload,b))return null;
 const preview=(await db.query("SELECT payload,status,result FROM resolution_jobs WHERE order_id=$1 AND action='equivalent-preview' AND status='complete' AND result->>'previewFingerprint'=$2 AND created_at<=$3 ORDER BY created_at DESC LIMIT 1",[o.id,failed.payload.previewFingerprint,failed.created_at])).rows[0];
 if(partial&&(!preview||preview.status!=='complete'||preview.result?.previewFingerprint!==failed.payload.previewFingerprint))throw Error('Aperçu du remplacement partiel absent : rapprochement requis avant toute nouvelle écriture.');
 const historicalStock=historical?await readHistoricalStock(api,bc,{additionalVariants:(preview?.result?.commercialBefore?.line_items||[]).filter(l=>l.type==='normal').map(l=>l.variant.id)}):null;
 try{return recordedSubstitutionPlan(bc,b,failed,preview,o,historicalStock);}catch(error){
  // Do not relax the historical/partial snapshot guards. Only old previews
  // lacking commercialBefore can be reconsidered against current source data.
  if(error.message!=='Remplacement déjà demandé : le BC doit être rapproché avant toute nouvelle modification. Aucune seconde écriture effectuée.'||historical||partial||preview?.result?.commercialBefore)throw error;
  const rows=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[o.id])).rows;
  const proof=proveLegacyCurrentSource({order:o,rows,failed,preview,bc});
  const money=v=>new Intl.NumberFormat('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
  return {...preview.result,reconcileOnly:true,recoveredFrom:failed.id,available:null,currentSourceProof:proof,
   recoverySummary:'Le BC '+(bc.label||bc.id)+' contient déjà le remplacement demandé. Ses produits, quantités, livraison et montants ont été rapprochés de la source actuelle. Total Erplain : '+money(proof.actual.total)+' '+bc.currency.label+' ; livraison HT : '+money(proof.actual.shippingNet)+' '+bc.currency.label+'. L’ancien aperçu ne permet pas de prouver les frais avant le remplacement. Après votre confirmation, V3 reprendra le contenu actuel de ce BC, sans nouvelle modification Erplain. Le stock et le BL seront ensuite contrôlés ; l’étiquette sera créée automatiquement si aucune étiquette n’existe déjà.',
   previewFingerprint:createHash('sha256').update(JSON.stringify({bc,failedId:failed.id,plan:preview.result,proof})).digest('hex')};
 }
}
