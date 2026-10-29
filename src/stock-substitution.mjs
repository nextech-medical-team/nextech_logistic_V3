import {historicalSubstitutionItems,verifyHistoricalSubstitutionLots} from './historical-substitution-lots.mjs';
import {substitutionExecutionSnapshot,substitutionBcSnapshot} from './substitution-execution-snapshot.mjs';
import {exactStockAvailability,exactQuantitySum,exactQuantityDifference} from './stock-decimal.mjs';
import {startSubstitutionAttempt,finishSubstitutionAttempt,substitutionMappingSnapshot} from './substitution-attempt.mjs';
import {importBcAmounts} from './import-bc-commercial.mjs';
import {chooseDocumentStockVariant} from './document-stock-choice.mjs';
import {proveShopifyStatusOnly} from './shopify-status-only-proof.mjs';
import {loadShopifyConfig,shopifyCollector} from './marketplace-collection.mjs';
import {provePartialRemainder,assertPartialShippingPreserved} from './partial-substitution-proof.mjs';
import {findRecordedSubstitution,recordedSubstitutionPlan} from './substitution-recovery.mjs';
import {readHistoricalStock,verifyHistoricalStock,assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';
import {verifySubstitutionShipping} from './substitution-shipping-check.mjs';
import {preserveSubstitutionLabels} from './preserve-substitution-labels.mjs';
import {rememberEquivalence} from './equivalence-catalog.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {assertWholeTemuPackage} from './temu-label-pdf.mjs';
import {verifiedRefusedSubstitutionPackage,refusedSubstitutionNotice} from './temu-refused-substitution.mjs';
import {resolveWeight} from './erplain-readonly.mjs';
const fingerprint=v=>createHash('sha256').update(JSON.stringify(substitutionExecutionSnapshot(v))).digest('hex');
const bcFields='id label created_at status total tax_type currency{label} update_stock line_items{id type quantity price discount discount_rule_amount ecotax tax_amount tax_codes{id tax_rates{rate}} reserved_quantity available on_hand batch_numbers{quantity batch_number{id}} location{id} variant{id sku active track_inventory weight_amount weight_unit product{id active}}} shipping_orders(first:100){data{id label status update_stock line_items{id type quantity location{id} variant{id sku}}} paginatorInfo{hasMorePages}}';
export function validateSubstitution(b,apply=false){
 if(typeof b.sku!=='string'||!b.sku.trim()||typeof b.replacementSku!=='string'||!b.replacementSku.trim()||b.replacementSku.length>199)throw Error('SKU original et SKU équivalent requis');
 if(b.sku.trim()===b.replacementSku.trim())throw Error('Choisir un SKU différent du produit en rupture');
 for(const field of ['replaceQuantity','replacementQuantity'])if(!['number','string'].includes(typeof b[field])||String(b[field]).trim()===''||!Number.isFinite(Number(b[field]))||Number(b[field])<=0)throw Error('Quantités de remplacement strictement positives requises');
 if(!['order','permanent'].includes(b.scope))throw Error('Choisir la portée de l’équivalence');
 if(b.verifyAndApply!==undefined&&b.verifyAndApply!==true)throw Error('Option de remplacement direct invalide');
 if(apply&&(b.confirmEquivalent!==true||b.verifyAndApply!==true&&!/^[a-f0-9]{64}$/.test(b.previewFingerprint||'')))throw Error('Vérifier et confirmer le produit équivalent avant enregistrement');
}
function inclusivePrice(bc,l){const price=Number(l.price)-Number(l.tax_amount)/Number(l.quantity);return bc.tax_type==='inclusive'&&l.price!=null&&l.tax_amount!=null&&Number.isFinite(price)?{price}:{};}
export function buildSubstitution(bc,variant,b,{preserveSourceTaxes=false,historicalStock=null,partialProof=null}={}){
 validateSubstitution(b);
 if(!bc?.id||![false,true].includes(bc.update_stock)||!['pending','unpublished','active'].includes(bc.status))throw Error('BC LIVE non modifiable : vérifier son statut et sa politique de stock');
 const historicalProof=bc.update_stock===true?verifyHistoricalStock(bc,historicalStock?.evidence):null;
 if(historicalProof&&b.scope!=='order')throw Error('BC historique : choisir « Équivalence juste pour cette commande » pour conserver une reprise vérifiable.');
 if(!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.data.length&&!partialProof)throw Error('Un BL existe déjà : le remplacement nécessite un rapprochement de la livraison');
 const allLines=bc.line_items,lines=shippingProductLines(allLines||[]);
 if(!Array.isArray(allLines)||allLines.some(l=>l.type!=='normal'&&l.type!=='shipping_cost'))throw Error('BC avec lignes particulières : contrôle manuel requis');
 if(allLines.some(l=>!l.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))throw Error('BC · Identités ou quantités de lignes incomplètes');
 const shipping=allLines.filter(l=>l.type==='shipping_cost');
 if(shipping.some(l=>!l.id))throw Error('Ligne de livraison incomplète');
 if(!lines?.length||lines.some(l=>!l.variant?.sku||!l.location?.id||!l.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))throw Error('BC avec lignes particulières ou incomplètes : vérifier les équivalents dans Erplain');
 const originals=lines.filter(l=>l.variant.sku===b.sku.trim());
 if(originals.length!==1)throw Error('SKU original absent ou présent sur plusieurs lignes du BC');
 const original=originals[0],replace=Number(b.replaceQuantity),quantity=Number(b.replacementQuantity);
 if(partialProof&&(String(partialProof.bcId)!==String(bc.id)||String(partialProof.originalLineId)!==String(original.id)||Number(original.quantity)-replace<partialProof.allocatedOriginal))throw Error('Quantité déjà allouée : remplacement interdit');
 if(replace>Number(original.quantity))throw Error('La quantité remplacée dépasse la quantité du BC');
 if(!variant?.id||variant.sku!==b.replacementSku.trim()||variant.active===false||variant.product?.active===false)throw Error('Produit équivalent actif requis dans Erplain LIVE');
 let weight;try{weight=resolveWeight([variant],variant.sku).weightKg;}catch(e){throw Error('Produit équivalent ['+variant.sku+'] : '+e.message);}
 if(typeof variant.track_inventory!=='boolean')throw Error('API Erplain · Politique de stock du produit équivalent non vérifiée');
 if(variant.track_inventory!==false){
  if(!Array.isArray(variant.stock_levels?.data)||variant.stock_levels.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Stock du produit équivalent incomplet');
  const stocks=variant.stock_levels.data.filter(s=>String(s.location?.id)===String(original.location.id));
  if(stocks.length!==1||[stocks[0].available,stocks[0].on_hand].some(v=>!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))))throw Error('API Erplain · Stock de l’emplacement non reçu');
  // Historical BC quantities were already deducted; require only the added quantity.
  const prior=historicalProof?'0':exactQuantityDifference(exactQuantitySum(lines.filter(l=>String(l.variant.id)===String(variant.id)&&String(l.location.id)===String(original.location.id)).map(l=>l.quantity)),partialProof?.allocated[String(variant.id)+':'+String(original.location.id)]||0),existing=Number(prior)<0?'0':prior;
  const stockRows=[quantity,existing].map(quantity=>({quantity,reserved_quantity:0,available:stocks[0].available,on_hand:stocks[0].on_hand})),budget=exactStockAvailability(stockRows);
  if(!budget.sufficient)throw Error('Produit de remplacement ['+variant.sku+'] : stock insuffisant. Quantité totale nécessaire : '+budget.need+' unités ; stock disponible : '+budget.usable+' unités ; quantité manquante : '+budget.missing+' unités. Remplacement non enregistré. Choisissez un autre produit ou réduisez la quantité à remplacer.');
 }
 const remaining=Number(original.quantity)-replace;
 for(const l of lines.filter(l=>l!==original||remaining>0)){try{resolveWeight([l.variant],l.variant.sku);}catch(e){throw Error('Produit restant ['+l.variant.sku+'] : '+e.message);}}
 // Existing IDs retain commercial fields not edited by this action.
 const items=lines.filter(l=>l!==original||remaining>0).map(l=>({id:String(l.id),quantity:l===original?remaining:Number(l.quantity),...inclusivePrice(bc,l)}));
 for(const l of shipping)items.push({id:String(l.id),quantity:Number(l.quantity),...inclusivePrice(bc,l)});
 const originalNet=original.price==null?NaN:Number(original.price)-(bc.tax_type==='inclusive'?Number(original.tax_amount)/Number(original.quantity):0);
 const newPrice=originalNet*replace/quantity;
 items.push({variant:{id:String(variant.id)},location:{id:String(original.location.id)},quantity,...(Number.isFinite(newPrice)?{price:newPrice}:{}),...(Array.isArray(original.tax_codes)?{tax_codes:original.tax_codes.map(t=>({id:String(t.id)}))}:{}),apply_discount_rules:false});
 const expected=lines.filter(l=>l!==original||remaining>0).map(l=>({sku:l.variant.sku,quantity:l===original?remaining:Number(l.quantity)}));expected.push({sku:variant.sku,quantity});
 return {commercialBefore:bc,bcId:String(bc.id),originalSku:original.variant.sku,replacementSku:variant.sku,replaceQuantity:replace,replacementQuantity:quantity,remaining,available:variant.track_inventory===false?null:Math.min(Number(variant.stock_levels.data.find(l=>String(l.location?.id)===String(original.location.id)).available),Number(variant.stock_levels.data.find(l=>String(l.location?.id)===String(original.location.id)).on_hand)),weightKg:weight,items,expected,previewFingerprint:fingerprint({bc:substitutionBcSnapshot(bc),variant:{id:variant.id,sku:variant.sku,weight_amount:variant.weight_amount,weight_unit:variant.weight_unit},replace,quantity}),message:'Produit et stock vérifiés dans Erplain LIVE. Remplacement limité à cette commande.'};
}
function totals(lines){const sums=new Map();for(const l of lines)sums.set(l.sku,(sums.get(l.sku)||0)+Number(l.quantity));return JSON.stringify([...sums].sort());}
export async function substitution(db,api,o,b,{apply=false,stage=async()=>{},directory,shopifyReader,deferResume=false,preserveBcAmounts=false}={}){
 validateSubstitution(b,apply);
 if(o.archived||o.erp_live?.bl?.id||o.erp_live?.stockDocument||/^(creating|publishing)/.test(o.erp_live?.phase||'')||(o.source_payload?.marketplacePendingCorrection&&!(o.channel==='shopify'&&o.partial_mode===true))||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Commande livrée, fractionnée ou modifiée : rapprochement requis avant remplacement');
 if(!o.erp_live?.bc?.id)throw Error('Créer ou retrouver le BC LIVE avant de remplacer ses produits');
 if(o.partial_mode&&b.scope!=='order')throw Error('Remplacement du reliquat limité à cette commande');
 const partials=o.partial_mode?(await db.query('SELECT id,status,selection,bl,error FROM partial_deliveries WHERE order_id=$1',[o.id])).rows:null;
 const jobs=(await db.query("SELECT status FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT status FROM carrier_jobs WHERE order_id=$1 AND status<>'ready' AND (status NOT IN ('failed','superseded') OR result IS NOT NULL OR jsonb_array_length(tracking)>0)",[o.id])).rows;
 if(jobs.length)throw Error('Traitement ou étiquette existante : attendre ou rapprocher avant remplacement');
 const carrier=(await db.query("SELECT * FROM carrier_jobs WHERE order_id=$1 AND status='ready'",[o.id])).rows[0];
 const temu=(await db.query("SELECT * FROM temu_label_jobs WHERE reference=$1 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0)",[o.reference])).rows[0];
 if(carrier&&o.channel==='temu')throw Error('Étiquette transporteur directe sur une commande TEMU : rapprocher cette expédition');
 let refusedTemu=false;
 if(temu){
  const originals=o.erp_live.equivalentOriginalLines||(await db.query('SELECT * FROM lines WHERE order_id=$1',[o.id])).rows;
  const documents=(await db.query('SELECT package FROM temu_label_documents WHERE reference=$1',[o.reference])).rows;
  refusedTemu=verifiedRefusedSubstitutionPackage(o,temu,originals,documents);
  if(!refusedTemu&&(o.channel!=='temu'||temu.status!=='complete'||temu.packages?.length!==1))throw Error('Achat TEMU en cours, incertain ou multi-colis : récupérer et vérifier le colis avant remplacement');
  assertWholeTemuPackage(o,originals,temu.result,temu.packages[0]);
  if(!refusedTemu&&!documents.some(d=>d.package===temu.packages[0]))throw Error('Récupérer le PDF TEMU acheté avant remplacement');
 }
 const labelNotice=refusedTemu?refusedSubstitutionNotice:o.partial_mode?'Les livraisons, étiquettes et suivis existants sont conservés intégralement. Seul le reliquat du BC est modifié ; aucun achat ni réimpression automatique.':temu||carrier?'Même étiquette et même suivi conservés. Les mentions SKU et quantités de l’édition V3 sont actualisées automatiquement avec l’équivalent. Téléchargez cette édition pour la réimprimer ; aucun nouvel achat.':'Après validation du stock et du BL, l’étiquette sera créée automatiquement. Aucun clic supplémentaire ne sera nécessaire.';
 await stage('Lecture du BC et du produit équivalent');await api.verify();
 const {Order:bc}=await api.request(`query V3SubstitutionBC($id:ID!){Order(id:$id){${bcFields}}}`,{id:String(o.erp_live.bc.id)});
 if(String(bc?.id)!==String(o.erp_live.bc.id))throw Error('API Erplain · BC demandé non reçu');
 // A recorded BC is authoritative: no amount/source comparison after creation.
 if(bc.update_stock===true)await assertNoHistoricalStockRemoval(api,o);
 let plan=await findRecordedSubstitution(db,o,b,bc,api);
 if(!plan){
 const partialProof=o.partial_mode?provePartialRemainder(o,bc,partials,b):null;
 const lookup=await api.request('query V3SubstitutionProduct($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku active weight_amount weight_unit track_inventory tax_codes{id} product{id label active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:b.replacementSku.trim()}});
 if(!Array.isArray(lookup.Variants?.data)||lookup.Variants.paginatorInfo?.hasMorePages)throw Error('API Erplain · Catalogue incomplet');
 let found=lookup.Variants.data.filter(v=>v.sku===b.replacementSku.trim()&&v.active!==false&&v.product?.active!==false);
 if(!found.length)throw Error('SKU équivalent introuvable ou inactif dans Erplain');
 if(found.length>1){
  const original=bc.line_items.filter(l=>l.type==='normal'&&l.variant?.sku===b.sku);
  if(original.length!==1||!original[0].location?.id)throw Error('Produit initial ou emplacement ambigu');
  const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[b.replacementSku.trim()])).rows[0]?.live_variant_id;
  found=[chooseDocumentStockVariant(found,{sku:b.replacementSku.trim(),locationId:original[0].location.id,document:bc,variantId:linked}).variant];
 }
 // Amazon replacements retain the order line's source VAT, regardless of product defaults.
 const historicalStock=bc.update_stock===true?await readHistoricalStock(api,bc,{additionalVariants:[found[0].id]}):null;
 plan=buildSubstitution(bc,found[0],b,{preserveSourceTaxes:['amazon','temu','shopify','tender','samples'].includes(o.channel),historicalStock,partialProof});
 if(partialProof)plan.partialProof=partialProof;
 if(historicalStock)plan.historicalStockProof=historicalStock.proof;
 }
 if(bc.update_stock===true&&!plan.reconcileOnly){
  plan.items=await historicalSubstitutionItems(api,bc,plan);
  plan.previewFingerprint=fingerprint({preview:plan.previewFingerprint,lots:plan.items.filter(l=>!l.id).map(l=>({variant:l.variant,location:l.location,quantity:l.quantity,batch_numbers:l.batch_numbers||[]}))});
 }
 const mappingLines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty AS mapping_source_qty,m.target_qty AS mapping_target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
 if(o.source_payload?.marketplacePendingCorrection||(o.channel==='shopify'&&o.partial_mode&&o.source_payload?.id)){
  if(!plan.partialProof)throw Error('Modification marketplace : rapprochement requis');
  const read=shopifyReader||(directory?async id=>{const config=await loadShopifyConfig(directory);if(String(config.SHOPIFY_STORE_DOMAIN||'').toLowerCase()!==String(o.source_payload.sourceShop||'').toLowerCase())throw Error('Shopify · Boutique différente de la commande');return shopifyCollector(config).order(id,{remaining:true});}:null);
  if(!read)throw Error('Shopify · Lecture du reliquat indisponible');
  await stage('Vérification du reliquat encore à expédier dans Shopify');
  const fresh=await read(String(o.source_payload.id));
  const pending=o.source_payload.marketplacePendingCorrection||fresh.payload;
  const before=plan.commercialBefore,original=before.line_items.find(l=>String(l.id)===plan.partialProof.originalLineId);
  // A recovery uses the recorded pre-change commercial snapshot, never the reduced line.
  provePartialRemainder(o,before,partials,b);
  plan.shopifyStatusProof=proveShopifyStatusOnly({order:o,pending,live:fresh.snapshot,livePayload:fresh.payload,sourceRows:o.erp_live.equivalentOriginalLines||mappingLines,sourceSku:plan.originalSku,orderedErplain:Number(original?.quantity),remainingErplain:plan.partialProof.remaining});
 }

 if(plan.attemptRecovery&&b.scope==='permanent'){
  if(plan.localCommitted){
   const current=(await db.query('SELECT target_sku,source_qty,target_qty FROM mappings WHERE channel=$1 AND source_sku=$2',[plan.recordedPermanent.channel,plan.recordedPermanent.source_sku])).rows;
   if(current.length!==1||current[0].target_sku!==plan.recordedPermanent.target_sku||Number(current[0].source_qty)!==Number(plan.recordedPermanent.source_qty)||Number(current[0].target_qty)!==Number(plan.recordedPermanent.target_qty))throw Error('Mapping modifié après synchronisation : rapprochement requis');
  }else if(fingerprint(substitutionMappingSnapshot(mappingLines))!==fingerprint(substitutionMappingSnapshot((plan.recordedMappingBefore||[]).map(r=>({source_sku:r.source_sku,mapped_sku:r.target_sku,mapping_source_qty:r.source_qty,mapping_target_qty:r.target_qty})))))throw Error('Mapping modifié depuis le remplacement : rapprochement requis');
 }
 const permanent=b.scope==='permanent'?(plan.localCommitted?plan.recordedPermanent:permanentEquivalentMapping(o,plan.attemptRecovery?plan.commercialBefore:bc,b,mappingLines)):null;if(plan.attemptRecovery&&((permanent===null)!==(plan.recordedPermanent===null)||['channel','source_sku','target_sku','source_qty','target_qty'].some(k=>permanent?.[k]!==plan.recordedPermanent?.[k])))throw Error('Mapping modifié depuis le remplacement : rapprochement requis');plan.labelNotice=labelNotice;plan.temuSubstitutionState=temu?{status:temu.status,packages:temu.packages,result:temu.result?.packageInfoResultList}:null;plan.previewFingerprint=fingerprint({plan:plan.previewFingerprint,scope:b.scope,permanent,shopifyStatusProof:plan.shopifyStatusProof||null,temu:temu?{status:temu.status,packages:temu.packages,result:temu.result?.packageInfoResultList}:null,carrier:carrier?{creation:carrier.creation_id,reference:carrier.reference,tracking:carrier.tracking}:null});if(!apply)return plan;
 // One explicit submission verifies the current ERP state and applies that same
 // plan in the existing locked worker. No browser round trip or saved preview.
 if(b.verifyAndApply===true)b={...b,previewFingerprint:plan.previewFingerprint};
 if(plan.previewFingerprint!==b.previewFingerprint){
  const saved=(await db.query("SELECT result,payload FROM resolution_jobs WHERE order_id=$1 AND action='equivalent-preview' AND status='complete' AND result->>'previewFingerprint'=$2 ORDER BY created_at DESC LIMIT 1",[o.id,b.previewFingerprint])).rows[0],prior=saved?.result;
  const operation=p=>({bc:substitutionBcSnapshot(p.commercialBefore),items:p.items,expected:p.expected,bcId:p.bcId,originalSku:p.originalSku,replacementSku:p.replacementSku,replaceQuantity:p.replaceQuantity,replacementQuantity:p.replacementQuantity,weightKg:p.weightKg});
  if((temu&&fingerprint(prior?.temuSubstitutionState??null)!==fingerprint(plan.temuSubstitutionState))||b.scope!=='order'||saved?.payload?.scope!==b.scope||prior?.labelNotice!==plan.labelNotice||!prior||fingerprint(operation(prior))!==fingerprint(operation(plan)))throw Error('BC ou produit modifié depuis la vérification : contrôler de nouveau');
 }
 if(plan.localCommitted){
  const attempt=await startSubstitutionAttempt(db,o,b,plan,permanent,mappingLines);
  const recoveredResult={...plan.completionResult,importDeferred:deferResume};
  await db.transaction(async tx=>{
   await tx.query('UPDATE orders SET resolution_pending_resume=$2 WHERE id=$1',[o.id,deferResume]);
   await finishSubstitutionAttempt(tx,o.id,b.requestId,attempt,recoveredResult);
  });
  return recoveredResult;
 }
 const originals=(await db.query('SELECT * FROM lines WHERE order_id=$1',[o.id])).rows;
 await stage('Préservation des étiquettes existantes');
 const preservedLabels=await preserveSubstitutionLabels(db,o.id);
 await stage('Enregistrement du remplacement dans le BC Erplain LIVE');
 const attempt=bc.update_stock===false&&!o.partial_mode&&plan.commercialBefore?await startSubstitutionAttempt(db,o,b,plan,permanent,mappingLines):null;
 let changed;
 try{changed=plan.reconcileOnly?{UpdateOrder:bc}:await api.request(`mutation V3SubstituteOrder($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){${bcFields}}}`,{id:plan.bcId,input:{tax_type:'exclusive',line_items:plan.items}});}catch(e){if(o.partial_mode)throw Error('Remplacement partiel à rapprocher : '+e.message);if(bc.update_stock===true)throw Error('Remplacement historique à rapprocher : '+e.message);throw e;}
 const updated=changed.UpdateOrder;
 let historicalAfter=null;
 try{
 if(!updated||String(updated.id)!==plan.bcId||updated.update_stock!==bc.update_stock||(updated.shipping_orders?.data?.length&&!plan.partialProof)||totals(shippingProductLines(updated.line_items||[]).map(l=>({sku:l.variant?.sku,quantity:l.quantity})))!==totals(plan.expected))throw Error('Remplacement non confirmé : relire le BC dans Erplain avant toute nouvelle tentative');
 if(plan.partialProof)assertPartialShippingPreserved(plan.commercialBefore,updated);
 if(!plan.reconcileOnly)verifySubstitutionShipping(bc,updated);
 if(attempt){
  if(updated.shipping_orders?.paginatorInfo?.hasMorePages!==false||updated.line_items.some(l=>l.type==='normal'&&(l.variant?.active!==true||l.variant?.product?.active!==true)))throw Error('Résultat du remplacement incomplet ou modifié : rapprocher le BC avant reprise.');
  const request={...b,scope:'order'};
  recordedSubstitutionPlan(updated,request,{id:b.requestId,status:'review',error:'Frais de livraison modifiés : rapprochement requis',payload:request},{status:'complete',payload:request,result:plan},o);
 }

 if(updated.update_stock===true)verifyHistoricalSubstitutionLots(updated,plan);
 if(updated.update_stock===true)historicalAfter=await readHistoricalStock(api,updated,{additionalVariants:plan.commercialBefore.line_items.filter(l=>l.type==='normal').map(l=>l.variant.id)});
 let weight=0;for(const l of shippingProductLines(updated.line_items))weight+=resolveWeight([l.variant],l.variant.sku).weightKg*Number(l.quantity);
 const completionResult={importDeferred:deferResume,temuLabelPreserved:!!temu&&!refusedTemu,temuLabelRefused:refusedTemu,regenerateExisting:false,erpOnly:true,preservedLabels,labelNotice,message:deferResume?'Remplacement enregistré. Préparation suspendue jusqu’aux autres lignes sélectionnées de cet import.':(plan.reconcileOnly?'BC déjà modifié : V3 synchronisé sans nouvelle écriture dans Erplain. ':'')+labelNotice+' Équivalent enregistré dans le BC Erplain LIVE et dans cette commande. Poids recalculé ; préparation remise en file pour contrôle du stock et du BL. '+(permanent?'Le mapping permanent est mis à jour pour les prochaines commandes de ce gestionnaire.':'Le mapping partagé est conservé.')};
 if(refusedTemu)completionResult.message=refusedSubstitutionNotice+' Remplacement enregistré dans le BC Erplain ; poids recalculé. Préparation suspendue jusqu’au rapprochement du colis TEMU.';
 await db.transaction(async tx=>{
  if(plan.shopifyStatusProof){
   const pending=o.source_payload.marketplacePendingCorrection;
   const reconciled=await tx.query("UPDATE orders SET source_payload=(source_payload-'marketplacePendingCorrection')||$3::jsonb WHERE id=$1 AND source_payload->'marketplacePendingCorrection' IS NOT DISTINCT FROM $2::jsonb RETURNING id",[o.id,pending?JSON.stringify(pending):null,JSON.stringify({fulfillment_status:plan.shopifyStatusProof.fulfillmentStatus,updated_at:plan.shopifyStatusProof.version,shopifyPartialStatusProof:plan.shopifyStatusProof})]);
   if(reconciled.rows.length!==1)throw Error('La commande Shopify a changé pendant le remplacement : rapprocher le résultat');
  }
  if(permanent)await tx.query('INSERT INTO mappings(channel,source_sku,target_sku,source_qty,target_qty,notes,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(channel,source_sku) DO UPDATE SET target_sku=excluded.target_sku,source_qty=excluded.source_qty,target_qty=excluded.target_qty,notes=excluded.notes,updated_at=now()',[permanent.channel,permanent.source_sku,permanent.target_sku,permanent.source_qty,permanent.target_qty,'Équivalence permanente confirmée']);
  if(Number(plan.replaceQuantity)===Number(plan.replacementQuantity))await rememberEquivalence(tx,plan.originalSku,plan.replacementSku);
  const state={...o.erp_live,bc:{...o.erp_live.bc,...updated},equivalentOriginalLines:o.erp_live.equivalentOriginalLines||originals,equivalentItems:shippingProductLines(updated.line_items).map(l=>({variant:{id:String(l.variant.id)},location:{id:String(l.location.id)},quantity:Number(l.quantity),price:Number(l.price),description:l.variant.sku})),equivalentRefreshedAt:new Date().toISOString(),labelReprintNotice:labelNotice||null,equivalentReconciledFrom:plan.recoveredFrom||null,phase:'bc_created',verifiedAt:null,stockCheckedAt:null,labelPreparationFingerprint:null};
  state.substitutionDiagnostics={bcId:String(updated.id),retiredSkus:[...new Set([...(String(o.erp_live.substitutionDiagnostics?.bcId)===String(updated.id)?o.erp_live.substitutionDiagnostics.retiredSkus||[]:[]),...shippingProductLines(bc.line_items).map(l=>l.variant.sku)])].filter(sku=>!updated.line_items.some(l=>l.variant?.sku===sku))};
  if(attempt)state.equivalentAttemptId=b.requestId;
  state.documentSource={...o.erp_live.documentSource,checkedAt:new Date().toISOString(),lines:shippingProductLines(updated.line_items).map(l=>({lineId:String(l.id),sku:l.variant.sku,quantity:Number(l.quantity)})),shippingOrders:updated.shipping_orders.data};
  if(preserveBcAmounts&&attempt)state.importBcAmounts=importBcAmounts(updated,b.requestId);
  else delete state.importBcAmounts;
  if(historicalAfter)state.historicalStockProof=historicalAfter.proof;
  if(plan.partialProof){
   if(!o.erp_live.equivalentOriginalLines)state.equivalentOriginalLines=mappingLines;
   state.phase=o.erp_live.phase;
   const shipping=updated.shipping_orders.data.filter(bl=>bl.status!=='cancelled');
   state.partialSource={...o.erp_live.partialSource,checkedAt:new Date().toISOString(),allocatedBlIds:shipping.map(bl=>String(bl.id)),allocations:shipping.flatMap(bl=>bl.line_items.filter(l=>l.type==='normal').map(l=>({sku:l.variant.sku,quantity:Number(l.quantity)}))),lines:shippingProductLines(updated.line_items).map(l=>({lineId:String(l.id),sku:l.variant.sku,quantity:Number(l.quantity)})),pricing:{total:Number(updated.total),tax:updated.line_items.reduce((n,l)=>n+Number(l.tax_amount),0),currency:updated.currency?.label}};
   state.documentSource={...o.erp_live.documentSource,...state.partialSource,shippingOrders:updated.shipping_orders.data};
  }
  if(o.source_payload?.erplainImported)state.importedItems=state.equivalentItems;
  await tx.query('DELETE FROM lines WHERE order_id=$1',[o.id]);
  for(const l of shippingProductLines(updated.line_items)){const w=resolveWeight([l.variant],l.variant.sku).weightKg;await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,target_sku,target_quantity,source_payload) VALUES($1,$2,$3,$4,$5,$4,$5,$6)',[randomUUID(),o.id,'ERP:'+l.id,l.variant.sku,Number(l.quantity),JSON.stringify({origin:'erplain_live_equivalent',bcLineId:l.id,erplainSourceVariantId:String(l.variant.id),erplainCorrectedWeightKg:w})]);await tx.query("INSERT INTO products(sku,weight_kg,origin,updated_at) VALUES($1,$2,'erplain_live_equivalent',now()) ON CONFLICT(sku) DO UPDATE SET weight_kg=excluded.weight_kg,origin=excluded.origin,updated_at=now()",[l.variant.sku,w]);}
  await tx.query("UPDATE orders SET erp_live=$2,weight_kg=$3,resolution_pending_resume=false,label_status=$4,issue=null WHERE id=$1",[o.id,JSON.stringify(state),weight,plan.partialProof?'partial':'pending']);
  await tx.query("UPDATE jobs SET status='complete',error=null WHERE order_id=$1 AND kind='label'",[o.id]);
  await tx.query("INSERT INTO erp_live_jobs(order_id,status) VALUES($1,$2) ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,error=null,updated_at=now()",[o.id,plan.partialProof?'partial':'pending']);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','order.product_substituted',$1)",[JSON.stringify({orderId:o.id,originalSku:plan.originalSku,replacementSku:plan.replacementSku,replaceQuantity:plan.replaceQuantity,replacementQuantity:plan.replacementQuantity})]);
  if(attempt)await finishSubstitutionAttempt(tx,o.id,b.requestId,attempt,completionResult);
  if(refusedTemu){
   await tx.query('UPDATE orders SET resolution_pending_resume=true,issue=$2 WHERE id=$1',[o.id,refusedSubstitutionNotice]);
   await tx.query("UPDATE erp_live_jobs SET status='review',error=$2 WHERE order_id=$1",[o.id,refusedSubstitutionNotice]);
  }
  if(deferResume){
   await tx.query("UPDATE orders SET resolution_pending_resume=true,issue='Import des équivalences : autres lignes sélectionnées en attente' WHERE id=$1",[o.id]);
   await tx.query("UPDATE erp_live_jobs SET status='review',error='Import des équivalences : autres lignes sélectionnées en attente' WHERE order_id=$1",[o.id]);
  }

 });
 if(plan.partialProof)return {partialRemainder:true,erpOnly:true,preservedLabels,labelNotice,message:'Remplacement du reliquat enregistré dans le BC. Les livraisons, étiquettes et suivis existants sont inchangés. Le reliquat peut être préparé séparément ; aucun achat automatique.'};
 return completionResult;
 }catch(e){if(o.partial_mode)throw Error('Remplacement partiel à rapprocher : '+e.message);if(bc.update_stock===true)throw Error('Remplacement historique à rapprocher : '+e.message);throw e;}
}

export function permanentEquivalentMapping(o,bc,b,rows){
 if(!['amazon','shopify','temu','rakuten'].includes(o.channel)||o.source_payload?.erplainImported)throw Error('Équivalence permanente : utiliser le mapping du gestionnaire source');
 const product=shippingProductLines(bc.line_items).filter(l=>l.variant?.sku===b.sku);
 if(product.length!==1||Number(product[0].quantity)!==Number(b.replaceQuantity))throw Error('Une équivalence permanente nécessite le remplacement complet du produit');
 const matched=rows.filter(l=>(l.target_sku||l.mapped_sku)===b.sku);
 if(!matched.length||new Set(matched.map(l=>l.source_sku)).size!==1)throw Error('SKU source absent ou ambigu pour une équivalence permanente');
 return {channel:o.channel,source_sku:matched[0].source_sku,target_sku:b.replacementSku,source_qty:matched.reduce((s,l)=>s+Number(l.quantity),0),target_qty:Number(b.replacementQuantity)};
}
