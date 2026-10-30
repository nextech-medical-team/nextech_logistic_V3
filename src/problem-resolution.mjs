import {recoverMissingBc} from './missing-bc-recovery.mjs';
import {refreshErplainDocuments} from './erplain-documents-sync.mjs';
import {checkedResumeBc} from './resume-bc-read.mjs';
import {refreshCustomerIdentity} from './customer-refresh.mjs';
import {queueResolutionRequest} from './resolution-request.mjs';
import {assertImportedPostalAddress} from './imported-postal-authority.mjs';
import {abandonEquivalentPreview} from './abandon-equivalent.mjs';
import {completeOrderDocumentsSql} from './complete-order-documents.mjs';
import {usesRecordedBc} from './existing-bc-execution.mjs';
import {refreshCorrectionStatuses} from './correction-status-check.mjs';
import {resolveReplacementLines} from './resolution-quantities.mjs';
import {importedLabelDiagnosticReconciler} from './imported-label-diagnostic.mjs';
import {carrierPrevalidationReconciler} from './carrier-prevalidation-diagnostic.mjs';
import {catalogueLookupProof,refreshLookupDiagnostics} from './catalogue-lookup-diagnostics.mjs';
import {pendingBlDiagnosticReconciler} from './pending-bl-diagnostic.mjs';
import {projectSharedParcelContext} from './shared-parcel-diagnostic.mjs';
import {refreshWeightUnitDiagnostics} from './weight-unit-diagnostics.mjs';
import {ensureMissingProduct,productCreationBlock} from './missing-product-creation.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {continueSuccessfulCorrection} from './correction-continuation.mjs';
import {chooseDocumentStockVariant} from './document-stock-choice.mjs';
import {resolutionIncident,suspendReplacement} from './resolution-incident.mjs';
import {carrierDiagnosticReader} from './carrier-order-diagnostic.mjs';
import {shopifyDiagnosticReader} from './shopify-order-diagnostic.mjs';
import {stockChoiceLocation} from './stock-choice-location.mjs';
import {chooseActiveStockVariant} from './active-stock-choice.mjs';
import {partialAllocationSql} from './partial-allocation.mjs';
import {waitingResolutionWorker} from './resolution-waiting.mjs';
import {reconcileCompletedBlResumptions} from './resolution-bl-completion.mjs';
import {reconcileCompletedErpReviews} from './resolution-erp-review-completion.mjs';
import {reconcileMonetaryPreviews} from './financial-review-recovery.mjs';
import {reconcileResolvedStockReviews} from './resolved-stock-review.mjs';
import {saveManualPricing,pricingFingerprint} from './temu-manual-pricing.mjs';
import {assertManualLabelOrder,assertTemuManualLabel} from './manual-label-policy.mjs';
import {erplainWeightInput} from './erplain-weight-input.mjs';
import {attachEquivalentDiagnostics} from './equivalent-diagnostics.mjs';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {readComparisonLines} from './bc-comparison-lines.mjs';
import {applyMappingScope,validateMappingScope} from './mapping-scope.mjs';
import {substitution,validateSubstitution} from './stock-substitution.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {recoverOrder} from './erplain-document-metadata.mjs';
import {initializePriority} from './order-priority.mjs';
import {acceptMarketplaceChange} from './marketplace-change.mjs';
import {refreshManualOrder,manualOrderFields} from './manual-erplain-orders.mjs';
import {resolutionBcLines} from './resolution-bc-scope.mjs';
import {bcComparisonDiagnostic} from './resolution-bc-diagnostic.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {reconcileVerifiedWeights} from './verified-weight-diagnostics.mjs';
import {erplainLiveWorker} from './erplain-live-workflow.mjs';
import {randomUUID} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {initializeBindings,bindProduct} from './product-bindings.mjs';
import {saveMapping,mutablePreparation,normalizeMapping} from './mapping-store.mjs';
import {prepareLabel} from './workflow.mjs';
import {addressIssue} from './domain.mjs';
import {regenerateProductionLabels} from './label-regeneration.mjs';
import {correctionCatalog} from './problem-corrections.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
import {assertResumeStock} from './resume-stock-policy.mjs';
import {preparePublicationResume,commitPublicationResume} from './publication-resume.mjs';
import {createProductionCarriers,createTestCarriers} from './carriers-test.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const fields='id sku active weight_amount weight_unit track_inventory tax_codes{id} product{id label active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}';
const productTypes=['mapping','missing','duplicate','inactive','weight','weight-unit'];
const actionTypes={
 'manual-temu-pricing':['temu-pricing'],
 'choose-carrier':['routing'],
 'equivalent-preview':['stock'],'replace-equivalent':['stock'],'abandon-equivalent':['stock'],
 'reconcile-bc':['bc'],
 'check-sku':productTypes,'mapping':['mapping','missing'],'select-product':['duplicate'],
 'accept-source-change':['platform'],
 'create-product':['mapping','missing'],'activate-product':['inactive'],
 'weight':['weight','weight-unit'],'address':['address','city'],
 'relay':['relay','relay-search'],'compare-bc':['bc','stock','api-stock','historical-preparation','erplain-recovery'],'resume-erp':['stock','api-stock','historical-preparation','erplain-recovery','batch'],'force-stock-label':['stock'],
 'refresh':['customer','preparation','unknown','routing','stock','bc',...productTypes,'api-access','api-limit','api-server','api-timeout','api-network','api-stock','api-incomplete','api-http','uncertain','pdf','batch'],
 'recover-pdf':['pdf','uncertain'],'resume':['resolved']
};
export async function initializeResolutions(db){await initializePriority(db);
 await initializeBindings(db);
 await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_choice TEXT");
 await db.exec(`CREATE TABLE IF NOT EXISTS resolution_jobs(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id),request_id TEXT UNIQUE NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',stage TEXT NOT NULL DEFAULT 'En attente',payload JSONB NOT NULL,result JSONB,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE UNIQUE INDEX IF NOT EXISTS resolution_order_busy ON resolution_jobs(order_id) WHERE status IN ('queued','running','waiting');`);
 if(db.recoverInterrupted!==false)await db.query("UPDATE resolution_jobs SET status='review',stage='Vérification nécessaire',error='Intervention interrompue : relire les données avant toute nouvelle écriture.' WHERE status='running'");
 await reconcileVerifiedWeights(db);
}
function assertRefreshProvider(provider){
 if(provider!==undefined&&!['Erplain','TEMU','GLS','GOFO','Shopify'].includes(provider))throw Error('Lecture fournisseur indisponible : aucune donnée externe n’a été relue. Vérifiez la connexion dédiée avant toute reprise.');
}
export function validateResolution(b){
 if(b?.action==='refresh')assertRefreshProvider(b.provider);
 if(b?.type==='customer'&&b.provider!==undefined&&b.provider!=='Erplain')throw Error('Le rapprochement client nécessite Erplain');
 if(!actionTypes[b.action]?.includes(b.type))throw Error('Action incompatible avec le problème sélectionné');
 if(typeof b.id!=='string'||!b.id||!/^[a-f0-9-]{36}$/i.test(String(b.requestId)))throw Error('Commande et identifiant de demande requis');
 const allowed=['id','requestId','action','type','sku','resumeAfter',...({'manual-temu-pricing':['currency','priceLines','priceFingerprint','vatRate'],'choose-carrier':['carrier','confirmReplace'],'abandon-equivalent':['previewJobId'],'equivalent-preview':['replacementSku','replaceQuantity','replacementQuantity','scope'],'replace-equivalent':['replacementSku','replaceQuantity','replacementQuantity','scope','previewFingerprint','confirmEquivalent','verifyAndApply'],mapping:['channel','source_sku','target_sku','source_qty','target_qty','notes','variantId','scope'],weight:['weightKg','variantId'],'select-product':['variantId'],'activate-product':['variantId'],'create-product':['label','weightKg'],address:['address'],resume:[],relay:[],refresh:['provider','confirmCustomerAbsent','customerNumber','confirmMissingBc','missingBcId','orderReference']}[b.action]||[])];
 if(Object.keys(b).some(k=>!allowed.includes(k)))throw Error('La fenêtre ne peut modifier que les informations de ce problème');
 if(['check-sku','weight','select-product','activate-product','create-product'].includes(b.action)&&(!String(b.sku||'').trim()||b.sku.length>199))throw Error('SKU Erplain requis');
 if((b.confirmCustomerAbsent!==undefined||b.customerNumber!==undefined)&&(b.action!=='refresh'||b.type!=='customer'||b.confirmCustomerAbsent!==true||typeof b.customerNumber!=='string'||!b.customerNumber.trim()||b.customerNumber.length>250))throw Error('Confirmation explicite du client absent requise');
 if((b.confirmMissingBc!==undefined||b.missingBcId!==undefined||b.orderReference!==undefined)&&(b.action!=='refresh'||!['bc','unknown','api-incomplete'].includes(b.type)||b.provider!=='Erplain'||b.confirmMissingBc!==true||typeof b.missingBcId!=='string'||!/^\d+$/.test(b.missingBcId)||typeof b.orderReference!=='string'||!b.orderReference.trim()||b.orderReference.length>250))throw Error('Confirmation explicite de la commande et du BC absent requise');
 if(b.resumeAfter!==undefined&&typeof b.resumeAfter!=='boolean')throw Error('Option de reprise invalide');
 if(['equivalent-preview','replace-equivalent'].includes(b.action))validateSubstitution(b,b.action==='replace-equivalent');
 if(b.action==='abandon-equivalent'&&(typeof b.previewJobId!=='string'||!b.previewJobId))throw Error('Identifiant de l’aperçu requis');
 if(b.action==='choose-carrier'&&!['gls','gofo'].includes(b.carrier))throw Error('Choisir GLS ou GOFO');
 if(b.action==='mapping'){normalizeMapping(b);validateMappingScope(b.scope);}
 if(['weight','create-product'].includes(b.action)&&(!Number.isFinite(Number(b.weightKg))||Number(b.weightKg)<=0||Number(b.weightKg)>3000))throw Error('Poids unitaire entre 0 et 3000 kg requis');
 if(b.action==='create-product'&&(!String(b.label||'').trim()||b.label.length>250))throw Error('Nom du produit requis');
 if(b.action==='address'&&(addressIssue(b.address)||!/^[A-Z]{2}$/.test(String(b.address?.country||''))))throw Error('Adresse complète et pays ISO requis');
 return b;
}
export async function readSku(api,sku,selection={}){
 sku=typeof sku==='string'?sku.trim():'';if(!sku||sku.length>199)throw Error('SKU Erplain requis');
 const r=await api.request(`query V3ResolveSKU($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'SKU',operator:'EQ',value:sku}});
 const lookupReadAt=new Date().toISOString();
 if(!Array.isArray(r.Variants?.data)||r.Variants.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Réponse catalogue incomplète');
 if(r.Variants.data.length>=100)throw Error('API Erplain · Résultat trop volumineux, préciser le SKU');
 if(r.Variants.data.some(v=>v?.sku!==sku))throw Error('API Erplain · Recherche produit incohérente');
 const candidates=r.Variants.data;
 if(candidates.some(v=>typeof v.active!=='boolean'||typeof v.product?.active!=='boolean'||!/^\d+$/.test(String(v.id))||!/^\d+$/.test(String(v.product?.id))))throw Error('Identité ou activité produit non vérifiée');
 const active=candidates.filter(v=>v.active===true&&v.product.active===true);let chosen=null;
 if(typeof selection==='function')selection=active.length?await selection():{};
 if(!selection||typeof selection!=='object')throw Error('Contexte de sélection produit incomplet');
 if(active.length&&(selection.locationId||selection.variantId!=null))chosen=chooseDocumentStockVariant(candidates,{sku,...selection});
 const variant=chosen?.variant||(active.length===1?active[0]:null);
 return {sku,candidates,status:!candidates.length?'missing':!active.length?'inactive':variant?'active':'duplicate',usable:!!variant,variant,selection:chosen?{reason:chosen.reason,variantId:String(chosen.variant.id),usableStock:chosen.usable??null,locationId:chosen.locationId||String(selection.locationId)}:null,account:'Erplain LIVE',lookupProof:{readAt:lookupReadAt,responseComplete:true,locationId:selection.locationId??null,document:selection.document??null,paginatorInfo:r.Variants.paginatorInfo,documentId:selection.document?.id??null}};
}
function chooseProduct(result,id){
 if(id&&result.selection?.reason==='existing-document'&&String(id)!==String(result.variant?.id))throw Error('Produit déjà utilisé dans le BC : utiliser le parcours de remplacement pour changer sa référence');
 const v=id?result.candidates.find(v=>String(v.id)===String(id)):result.variant;
 if(!v)throw Error(result.status==='duplicate'?'SKU en doublon dans Erplain : choisir le produit exact':result.status==='missing'?'SKU Erplain introuvable':'Produit Erplain à vérifier');
 if(v.active===false||v.product?.active===false)throw Error('Produit inactif dans Erplain');
 return v;
}
// Retire only the legacy catalogue lookup failure proven obsolete by a newer
// verified TEST binding. Unrelated/API/stock/document errors must stay visible.
export async function retireVerifiedLookupError(tx,id){
 const job=(await tx.query("SELECT error,updated_at FROM erp_live_jobs WHERE order_id=$1 AND status='review'",[id])).rows[0];
 const match=/^Référence Erplain absente ou ambiguë : ([^;\r\n]+)$/.exec(job?.error||'');
 if(!match)return false;
 const sku=match[1].trim();
 const proof=(await tx.query(`SELECT b.sku,b.live_variant_id FROM lines l
 JOIN orders o ON o.id=l.order_id
 JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku AND m.target_sku=l.target_sku
 JOIN erplain_product_bindings b ON b.sku=l.target_sku
 WHERE o.id=$1 AND (l.target_sku=$2 OR NOT EXISTS(
 SELECT 1 FROM lines other LEFT JOIN mappings om ON om.channel=o.channel AND om.source_sku=other.source_sku AND om.target_sku=other.target_sku
 LEFT JOIN erplain_product_bindings ob ON ob.sku=other.target_sku
 WHERE other.order_id=o.id AND (om.source_sku IS NULL OR ob.sku IS NULL OR ob.verified_at<=$3
 OR ob.product->>'active'='false' OR ob.product->'product'->>'active'='false')))
 AND o.resolution_pending_resume=true
 AND b.verified_at>$3 AND b.product->>'id'=b.live_variant_id
 AND coalesce(b.product->>'active','true')='true'
 AND coalesce(b.product->'product'->>'active','true')='true'`,[id,sku,job.updated_at])).rows[0];
 if(!proof)return false;
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','resolution.obsolete_lookup_retired',$1)",[JSON.stringify({orderId:id,previousError:job.error,previousUpdatedAt:job.updated_at,...proof})]);
 // Pending is held by resolution_pending_resume until explicit finalisation.
 await tx.query("UPDATE erp_live_jobs SET status='pending',error=null,updated_at=now() WHERE order_id=$1",[id]);
 await tx.query("UPDATE orders SET erp_status='simulated_pending' WHERE id=$1",[id]);
 return true;
}
export async function recheckOrders(db,ids){
 const results=[];
 for(const id of [...new Set(ids)]){
  const o=(await db.query(`SELECT o.* FROM orders o WHERE o.id=$1 AND ${mutablePreparation}`,[id])).rows[0];
  if(!o){results.push({id,protected:true});continue;}
  try{await db.transaction(async tx=>{await tx.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[id]);await prepareLabel(tx,o);await tx.query("UPDATE jobs SET status='complete',error=null WHERE order_id=$1 AND kind='label'",[id]);await retireVerifiedLookupError(tx,id);});results.push({id,prepared:true});}
  catch(e){await db.query("UPDATE orders SET label_status='blocked',issue=$2 WHERE id=$1",[id,e.message]);await db.query("UPDATE jobs SET status='blocked',error=$2 WHERE order_id=$1 AND kind='label'",[id,e.message]);results.push({id,problem:e.message});}
 }
 return results;
}
async function affectedSku(db,sku){return (await db.query(`SELECT DISTINCT o.id FROM orders o JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE coalesce(l.target_sku,m.target_sku,l.source_sku)=$1 AND ${mutablePreparation}`,[sku])).rows.map(o=>o.id);}
async function context(db,directory,id){
 const order=(await db.query('SELECT orders.*, '+completeOrderDocumentsSql+' AS complete_order_documents FROM orders WHERE id=$1',[id])).rows[0];if(!order)throw Error('Commande introuvable');
 if(order.partial_mode)order.partial_allocation=(await db.query(`SELECT ${partialAllocationSql} allocation FROM orders WHERE id=$1`,[id])).rows[0]?.allocation||[];
 const lines=(await db.query(`SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty,m.notes,coalesce((l.source_payload->>'erplainCorrectedWeightKg')::numeric,p.weight_kg) weight_kg,c.message,b.live_variant_id FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku LEFT JOIN products p ON p.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) LEFT JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) LEFT JOIN erplain_product_bindings b ON b.sku=coalesce(l.target_sku,m.target_sku,l.source_sku) WHERE l.order_id=$1 ORDER BY source_line`,[id,order.channel])).rows;
 const job=(await db.query('SELECT status,error,environment,reference,tracking,stock_override FROM carrier_jobs WHERE order_id=$1',[id])).rows[0],erpJob=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0];
 let products=[];try{products=await correctionCatalog(directory,{cachedOnly:true});}catch{}
 const active=(await db.query("SELECT id,action,status,stage,created_at FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[id])).rows[0];
 const latest=(await db.query('SELECT status,error FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0];order.resolution_error=latest?.status==='review'?latest.error:null;await attachEquivalentDiagnostics(db,[order]);
 const temuJob=order.channel==='temu'?(await db.query('SELECT status,error,packages,attempt_id,result FROM temu_label_jobs WHERE reference=$1',[order.reference])).rows[0]:null;
 if(temuJob){temuJob.refusalReasons=(temuJob.result?.packageInfoResultList||[]).filter(p=>Number(p.shippingLabelStatus)===2).map(p=>({packageSn:p.packageSn,reason:p.failReasonText||null}));delete temuJob.result;}
 projectCurrentDiagnostics(Object.assign(order,{erp_live_job:erpJob,carrier_job:job,temu_job:temuJob}));
 if(order.order_delivered){for(const line of lines){line.message=null;line.catalog_issue=null;}return {order,lines:resolveReplacementLines(lines,order.channel,{bc:order.erp_live?.bc}),job,erpJob,products,active:null,temuJob,priceFingerprint:pricingFingerprint(lines)};}
 return projectSharedParcelContext({order,lines:resolveReplacementLines(lines,order.channel,{bc:order.erp_live?.bc}),job,erpJob,products,active,temuJob,priceFingerprint:pricingFingerprint(lines)});
}
export function resolutionService(db,directory,{api=erplainAccount(directory,'live'),clients,refreshTemuDiagnostic,refreshCarrierDiagnostic,refreshShopifyDiagnostic}={}){
 const diagnoseCarrier=refreshCarrierDiagnostic||carrierDiagnosticReader(db,directory).read;
 const pendingBlDiagnostics=pendingBlDiagnosticReconciler(db,api);
 const importedLabelDiagnostics=importedLabelDiagnosticReconciler(db,api);
 const carrierPrevalidationDiagnostics=carrierPrevalidationReconciler(db,api);
 const diagnoseShopify=refreshShopifyDiagnostic||shopifyDiagnosticReader(db,directory).read;
 const waiting=waitingResolutionWorker(db);
 let running=false,lastWeightStatusRefresh=0;
 const update=async(id,status,stage,result=null,error=null)=>{
  if(status==='complete'){
   const job=(await db.query('SELECT order_id,result FROM resolution_jobs WHERE id=$1',[id])).rows[0];
   if(!job)throw Error('Intervention introuvable pendant actualisation');
   const statusVerification=await refreshCorrectionStatuses(db,job.order_id);
   result={...(job.result||{}),...(result||{}),statusVerification};
   if(statusVerification.state==='needs_review')stage='Intervention effectuée · commande à vérifier';
  }
  return db.query('UPDATE resolution_jobs SET status=$2,stage=$3,result=coalesce($4::jsonb,result),error=$5,updated_at=now() WHERE id=$1',[id,status,stage,result?JSON.stringify(result):null,error]);
 };
 const failure=async(j,e)=>{
  // A local completion failure can happen after substitution cleared its hold.
  // Re-establish it before releasing the ERP/stock locks, without replaying the API.
  if(j.replacementSuspended)await suspendReplacement(db,j.order_id);
  const incident=resolutionIncident(e,j);
  await update(j.id,'review',incident?.preparationSuspended?'Remplacement à rapprocher · préparation suspendue':'À vérifier',incident,incident?.error||e.message);
 };
 async function carrierClient(environment){if(clients)return clients;const prod=environment==='production',config=JSON.parse(await readFile(path.join(directory,prod?'carriers-production.json':'carriers-test.json'),'utf8'));return prod?createProductionCarriers(config):createTestCarriers(config);}
 async function apply(j){
  if(j.action==='refresh')assertRefreshProvider(j.payload.provider);
  const b=j.payload,o=(await db.query('SELECT * FROM orders WHERE id=$1',[j.order_id])).rows[0];if(!o)throw Error('Commande introuvable');const suspended=suspensionBlock(o);if(suspended)throw Error(suspended);
 if(o.source_payload?.erplainValidationHold&&o.source_payload?.erplainValidation!=='approved'&&j.action!=='compare-bc'&&!(j.action==='refresh'&&['TEMU','GLS','GOFO','Shopify'].includes(b.provider)))throw Error('Commande Erplain en attente de validation manuelle : ouvrir Commandes Erplain à valider');
  const stage=async s=>{
   if(j.action==='replace-equivalent'&&s==='Enregistrement du remplacement dans le BC Erplain LIVE'){
    await suspendReplacement(db,o.id);j.replacementSuspended=true;
   }
   return update(j.id,'running',s);
  };
  const readOrderSku=sku=>readSku(api,sku,async()=>{
   const locationId=await stockChoiceLocation(directory);
   const bound=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[sku])).rows[0]?.live_variant_id;
   let document=null;
   if(o.erp_live?.bc?.id){const response=await api.request('query V3ResolveDocumentVariant($id:ID!){Order(id:$id){id line_items{type variant{id sku} location{id}}}}',{id:String(o.erp_live.bc.id)});document=response.Order;if(String(document?.id)!==String(o.erp_live.bc.id))throw Error('BC · Identité du document non vérifiée');}
   return {locationId,variantId:bound,document};
  });
  if(['mapping','weight','create-product','activate-product','select-product','address','relay'].includes(j.action)){
   const busy=(await db.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')",[o.id])).rows.length;
   if(busy)throw Error('Traitement déjà en cours : attendre sa fin avant de modifier les données de la commande');
  }
  if(j.action==='abandon-equivalent')return abandonEquivalentPreview(db,{orderId:o.id,previewJobId:b.previewJobId,resolutionId:j.id});
  if(['equivalent-preview','replace-equivalent'].includes(j.action)){
   let deferResume=false;
   if(b.importRow){
    const imported=(await db.query("SELECT r.* FROM equivalence_import_rows r JOIN equivalence_imports i ON i.id=r.batch_id WHERE r.batch_id=$1 AND r.line=$2 AND r.request_id=$3 AND r.job_id=$4 AND r.order_id=$5 AND r.status='processing' AND i.status='applying'",[b.importRow.batchId,b.importRow.line,b.requestId,j.id,o.id])).rows[0];
    if(!imported)throw Error('Ligne d’import non confirmée : aucune modification effectuée');
    deferResume=(await db.query("SELECT 1 FROM equivalence_import_rows WHERE batch_id=$1 AND order_id=$2 AND status='queued'",[imported.batch_id,o.id])).rows.length>0;
    if(deferResume&&(o.partial_mode||o.erp_live?.bc?.update_stock===true))throw Error('Plusieurs remplacements sur une livraison partielle ou un BC historique : rapprochement requis avant reprise');
   }
   const result=await substitution(db,api,o,b,{apply:j.action==='replace-equivalent',stage,directory,deferResume,preserveBcAmounts:!!b.importRow});
   if(j.action==='equivalent-preview'||result.partialRemainder||result.importDeferred||result.temuLabelRefused)return result;
   await update(j.id,'waiting','Équivalent enregistré · contrôle stock et BL',{...result,equivalent:true});return null;
  }
  if(j.action==='manual-temu-pricing'){await stage('Enregistrement des prix et quantités');const result=await saveManualPricing(db,o.id,b,j.id);return {...result,manualPricing:true,erpOnly:true,checks:await recheckOrders(db,[o.id])};}
  if(j.action==='choose-carrier'){
   assertManualLabelOrder(o,b.carrier,{manualChoice:true});
   await assertOrderEditable(o,true);
   const previous=(await db.query('SELECT status,carrier FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
   if(previous?.status==='ready'&&b.confirmReplace!==true)throw Error('Confirmez le remplacement et la réimpression de l’étiquette existante');
   if(o.channel==='temu'){
    const t=(await db.query('SELECT status,packages,attempt_id FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];
    assertTemuManualLabel(t);
    if((t?.attempt_id||t?.packages?.length)&&b.confirmReplace!==true)throw Error('Confirmez le remplacement : l’achat TEMU existant ne sera pas annulé ni remboursé');
   }
   if(b.carrier==='gofo'&&String(o.address?.country).trim().toUpperCase()!=='FR')throw Error('GOFO : livraison en France uniquement ; choisir GLS pour ce pays');
   await stage('Enregistrement du transporteur pour cette commande');
   await db.query('UPDATE orders SET transport_choice=$2 WHERE id=$1',[o.id,b.carrier]);
   const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
   await db.transaction(async tx=>{await tx.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[o.id]);await prepareLabel(tx,fresh);});
   return {regenerateExisting:previous?.status==='ready',message:'Choix '+b.carrier.toUpperCase()+' enregistré pour cette commande. Les règles partagées restent inchangées.',checks:[{id:o.id,prepared:true}]};
  }
  if(j.action==='accept-source-change')return {...await acceptMarketplaceChange(db,o.id,'system'),checks:await recheckOrders(db,[o.id])};
  if(j.action==='check-sku'){
   await stage('Lecture du SKU dans Erplain LIVE');await api.verify();const found=await readOrderSku(b.sku.trim());
   if(!found.usable)return {...found,provider:'Erplain',readOnly:true,diagnosticOnly:true,sourceReadOnly:true,errors:[]};
   const proof=catalogueLookupProof({sku:found.sku,response:{Variants:{data:found.candidates,paginatorInfo:found.lookupProof.paginatorInfo}},locationId:found.lookupProof.locationId,document:found.lookupProof.document,readAt:found.lookupProof.readAt});
   return {...found,...await refreshLookupDiagnostics(db,o,proof)};
  }
  if(j.action==='mapping'){
   if(b.scope==='order'&&o.erp_live?.bc?.id)throw Error('BC déjà créé : utilisez « Remplacer un produit » pour modifier ce BC.');
   if(b.channel!==o.channel)throw Error('Ce gestionnaire ne correspond pas à la commande. Utiliser Mapping SKU pour un autre gestionnaire.');
   if(!(await db.query('SELECT id FROM lines WHERE order_id=$1 AND source_sku=$2',[o.id,b.source_sku.trim()])).rows.length)throw Error('SKU gestionnaire absent de cette commande');
   await stage('Vérification du produit Erplain');await api.verify();const v=chooseProduct(await readOrderSku(b.target_sku.trim()),b.variantId);
   await bindProduct(db,v);await stage(b.scope==='permanent'?'Enregistrement dans Mapping SKU':'Correction de cette commande uniquement');const saved=await applyMappingScope(db,b,o.id,saveMapping);
   await stage('Recalcul des commandes concernées');return {message:b.scope==='permanent'?'Mapping permanent enregistré pour les prochaines commandes sans BC. Les BC existants sont conservés ; utilisez « Remplacer un produit » pour les modifier.':'Correction enregistrée uniquement pour cette commande. La base de mapping reste inchangée.',...saved,checks:await recheckOrders(db,saved.affected)};
  }
  if(['weight','create-product','activate-product','select-product'].includes(j.action)){
   await stage('Lecture du produit Erplain LIVE');await api.verify();let found=await readOrderSku(b.sku.trim()),v;
   const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[b.sku])).rows[0]?.live_variant_id;
   if(j.action==='create-product'){
    if(found.candidates.length)throw Error('Ce SKU existe déjà dans Erplain. Vérifier le produit existant avant toute création.');
    const created=await ensureMissingProduct(db,api,{sku:b.sku.trim(),label:b.label.trim(),weightKg:b.weightKg,stage,guard:async()=>{
     const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
     if(productCreationBlock(fresh,{resolution:true}))throw Error('Commande protégée : création suspendue');
    }});
    v=created.variant;
   }else if(j.action==='activate-product'){
    v=found.candidates.find(v=>String(v.id)===String(b.variantId))||(found.candidates.length===1?found.candidates[0]:null);if(!v)throw Error('Choisir le produit Erplain à réactiver');
    await stage('Réactivation du produit Erplain LIVE');
    if(v.product?.active===false)await api.request('mutation V3ResolutionEnableProduct($id:ID!){EnableProduct(id:$id){id active}}',{id:String(v.product.id)});
    if(v.active===false)await api.request('mutation V3ResolutionEnableVariant($id:ID!){EnableVariant(id:$id){id active}}',{id:String(v.id)});
    v=chooseProduct(await readOrderSku(b.sku),v.id);
   }else{
    v=chooseProduct(found,b.variantId||found.variant?.id||linked);
    if(j.action==='weight'){
     await stage('Enregistrement du poids dans Erplain LIVE');await api.request('mutation V3ResolutionWeight($id:ID!,$input:VariantInput!){UpdateVariant(id:$id,input:$input){id}}',{id:String(v.id),input:erplainWeightInput(b.weightKg)});
     await stage('Relecture et contrôle du poids enregistré');v=chooseProduct(await readOrderSku(b.sku),v.id);
     // Erplain is authoritative: bind the reread value, including rounding and unit conversion.
    }
   }
   const binding=await bindProduct(db,v);const ids=await affectedSku(db,v.sku);await stage('Recalcul des commandes utilisant ce SKU');
   return {message:j.action==='weight'?(binding.weightKg?'Poids pris en compte : '+new Intl.NumberFormat('fr-FR').format(binding.weightKg*1000)+' g.':'Erplain retourne encore un poids nul : correction non confirmée.'):j.action==='create-product'?'Produit créé et relu dans Erplain LIVE. Aucun stock fictif ajouté.':'Produit Erplain enregistré comme référence commune pour ce SKU.',product:binding,checks:await recheckOrders(db,ids),variant:v};
  }
  if(j.action==='address'){
   assertImportedPostalAddress(o,b.address);
   await assertOrderEditable(o);const address={...o.address};for(const k of ['name','street','postal','city','country','phone','email'])address[k]=String(b.address[k]||'').trim();
   await stage('Mise à jour de l’adresse de cette commande dans Erplain LIVE');await api.verify();
   // Check every document before changing the first one: a closed BL must also protect its BC.
   for(const [key,entity]of [['bc','Order'],['bl','ShippingOrder']])if(o.erp_live?.[key]?.id){
    const before=await api.request(`query V3ResolutionDocument($id:ID!){${entity}(id:$id){id status}}`,{id:String(o.erp_live[key].id)});
    if(!before[entity]?.id||['cancelled','closed','completed','delivered','shipped'].includes(before[entity].status))throw Error('Document Erplain absent ou clôturé : adresse non modifiée');
   }
   for(const [key,entity,type]of [['bc','Order','OrderInput'],['bl','ShippingOrder','ShippingOrderInput']])if(o.erp_live?.[key]?.id){
    const id=String(o.erp_live[key].id);
    const erpAddress={label:address.name,address_1:address.street,city:address.city,postal_code:address.postal,country:address.country,phone:address.phone||null};
    await api.request(`mutation V3ResolutionAddress($id:ID!,$input:${type}!){Update${entity}(id:$id,input:$input){id}}`,{id,input:{shipping_address:erpAddress}});
    const read=await api.request(`query V3ResolutionAddressVerify($id:ID!){${entity}(id:$id){shipping_address{label address_1 city postal_code country phone}}}`,{id});
    if(Object.entries(erpAddress).some(([k,v])=>String(read[entity]?.shipping_address?.[k]||'')!==String(v||'')))throw Error('API Erplain · Adresse relue différente de la correction');
   }
   await db.query('UPDATE orders SET address=$2,recipient=$3 WHERE id=$1',[o.id,JSON.stringify(address),address.name]);
   return {message:'Adresse enregistrée uniquement pour cette commande et ses documents Erplain LIVE existants.',checks:await recheckOrders(db,[o.id])};
  }
  if(j.action==='relay'){
   await assertOrderEditable(o);if(o.carrier!=='gls_shop'&&o.source_payload?.shopifyDeliveryMode!=='relay')throw Error('Cette commande n’est pas une livraison relais');
   await stage('Recherche du relais GLS le plus proche');const c=(await db.query('SELECT environment FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];const shop=await (await carrierClient(c?.environment||'production')).resolveParcelShop(o);
   if(!shop?.parcelShopId)throw Error('GLS · Aucun relais trouvé');
   await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({glsParcelShopId:shop.parcelShopId,glsParcelShop:shop})]);
   return {message:'Relais GLS enregistré pour cette commande. Le relais déjà choisi par le client est conservé.',shop,checks:await recheckOrders(db,[o.id])};
  }
  if(j.action==='reconcile-bc'){
   await stage('Recherche du BC existant dans Erplain LIVE');await api.verify();
   let found;if(o.erp_live?.bc?.id){const r=await api.request('query V3ReconcileExistingBC($id:ID!){Order(id:$id){id label status}}',{id:String(o.erp_live.bc.id)});found=r.Order;}else found=await recoverOrder(api,o,{db});
   const current={...o.erp_live,bcReconciliation:{status:found?'found':'missing',checkedAt:new Date().toISOString()}};
   if(found){current.bc=found;if(!current.bl?.id)current.phase='bc_created';}
   await db.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(current)]);
   if(found)await db.query("UPDATE erp_live_jobs SET error=null,updated_at=now() WHERE order_id=$1 AND status='review' AND error ~* '(incertain|interrompu|création à vérifier)'",[o.id]);
   return {message:found?'BC retrouvé dans Erplain LIVE et rattaché : '+found.label:'Aucun BC correspondant retrouvé dans Erplain LIVE. Aucune création relancée.'};
  }
  if(j.action==='compare-bc'){
   if(!o.erp_live?.bc?.id)throw Error('BC Erplain non créé');await stage('Lecture du BC et de ses livraisons');await api.verify();
   const r=await api.request('query V3ResolutionCompare($id:ID!){Order(id:$id){id label status line_items{id type quantity shipped_quantity available on_hand variant{id sku}} shipping_orders(first:100){data{id label status line_items{parent_id type quantity variant{id sku}}} paginatorInfo{hasMorePages}}}}',{id:String(o.erp_live.bc.id)});
   const lines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
   return bcComparisonDiagnostic(o,r.Order,lines);
  }
  if(j.action==='resume-erp'){
   if(o.archived||o.erp_live?.bc?.status==='cancelled')throw Error('Commande archivée ou BC annulé : reprise du BL non autorisée');
   if(!usesRecordedBc(o)&&o.source_payload?.marketplacePendingCorrection)throw Error('Commande modifiée sur la plateforme : vérifier les nouvelles données avant reprise');
   if(o.partial_mode)throw Error('Utiliser la préparation de la livraison partielle');
   if(!o.erp_live?.bc?.id)throw Error('BC Erplain non créé');
   await stage('Relecture du stock dans Erplain LIVE');await api.verify();
   const r=await api.request(`query V3ResolutionStock($id:ID!){Order(id:$id){${o.source_payload?.erplainImported?manualOrderFields:'id status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}'}}}`,{id:String(o.erp_live.bc.id)});
   if(!r.Order?.line_items?.length)throw Error('API Erplain · Stock non reçu');
   if(['closed','cancelled','completed'].includes(r.Order.status))throw Error('BC clôturé : reprise du BL non autorisée');
   if(r.Order.status!=='active')throw Error('API Erplain · État actif du BC non confirmé');
   const resumeStockLines=resolutionBcLines(o,r.Order);
   if(String(r.Order.id)!==String(o.erp_live.bc.id))throw Error('API Erplain · BC reçu différent du BC demandé');
   if(!usesRecordedBc(o)){
    const desired=usesRecordedBc(o)?[]:await readComparisonLines(db,o);
    const total=rows=>{const sums=new Map();for(const l of shippingProductLines(rows)){const sku=l.sku||l.variant?.sku,quantity=Number(l.quantity);if(typeof sku!=='string'||!sku.trim()||!Number.isFinite(quantity)||quantity<=0)throw Error('Produits ou quantités du BC non vérifiables : reprise non autorisée');sums.set(sku,(sums.get(sku)||0)+quantity);}return JSON.stringify([...sums].sort());};
    if(total(desired)!==total(resumeStockLines)&&(o.source_payload?.erplainImported||o.erp_live?.bl?.id))throw Error('Commande V3 et livraison existante différentes : vérifier les quantités avant reprise');
   }
   const recoveredDraft=await preparePublicationResume(db,api,o,{resolutionId:j.id});
   await assertResumeStock(api,recoveredDraft?{...o,erp_live:recoveredDraft}:o,r.Order,resumeStockLines);
   await db.transaction(async tx=>{const e=(await tx.query('SELECT status FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];if(e?.status==='processing')throw Error('Traitement Erplain en cours');
    if(recoveredDraft)await commitPublicationResume(tx,o,recoveredDraft,{resolutionId:j.id,userEmail:j.user_email||'system'});
    await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
    await tx.query("INSERT INTO erp_live_jobs(order_id,status) VALUES($1,'pending') ON CONFLICT(order_id) DO UPDATE SET status='pending',error=null,updated_at=now()",[o.id]);
    await tx.query("UPDATE resolution_jobs SET status='waiting',stage='Reprise du BL Erplain',result=$2,updated_at=now() WHERE id=$1",[j.id,JSON.stringify({resume:true})]);});return null;
  }
  if(j.action==='force-stock-label'){
   if(o.channel==='temu')throw Error('TEMU : les étiquettes doivent être achetées dans le circuit TEMU. Le forçage est interdit.');
   if(o.archived||o.erp_live?.bc?.status==='cancelled'||o.tracking_status==='cancelled'||o.partial_mode||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Dérogation réservée à une commande complète non expédiée');
   const carrier=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
   if(carrier?.status==='ready')return {message:'Étiquette déjà disponible : aucune nouvelle création.'};
   await assertOrderEditable(o);
   if(!o.erp_live?.bc?.id){
    await stage('Création ou récupération du BC seul dans Erplain LIVE');
    await erplainLiveWorker(db,directory,{api}).run({bcOnlyOrderId:o.id});
    const fresh=(await db.query('SELECT erp_live FROM orders WHERE id=$1',[o.id])).rows[0];
    o.erp_live=fresh.erp_live;
    if(!o.erp_live?.bc?.id){const e=(await db.query('SELECT error FROM erp_live_jobs WHERE order_id=$1',[o.id])).rows[0];throw Error(e?.error||'API Erplain · BC non confirmé');}
   }
   await stage('Vérification du stock et des quantités avant dérogation');await api.verify();
   const r=await api.request(`query V3ResolutionStock($id:ID!){Order(id:$id){${o.source_payload?.erplainImported?manualOrderFields:'id status line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}'}}}`,{id:String(o.erp_live.bc.id)});
   if(!r.Order?.line_items?.length)throw Error('API Erplain · Stock non reçu : dérogation non autorisée');
   if(['closed','cancelled','completed'].includes(r.Order.status))throw Error('BC clôturé : dérogation non autorisée');
   const desired=usesRecordedBc(o)?[]:await readComparisonLines(db,o);
   const total=rows=>{const sums=new Map();for(const l of shippingProductLines(rows)){const sku=l.sku||l.variant?.sku;sums.set(sku,(sums.get(sku)||0)+Number(l.quantity));}return JSON.stringify([...sums].sort());};
   const stockLines=resolutionBcLines(o,r.Order);
   if(!usesRecordedBc(o)&&total(desired)!==total(stockLines))throw Error('Commande V3 et BC différents : vérifier les quantités avant dérogation');
   let reason;try{assertFullOrderStock(stockLines,{preserveInstalled:o.channel==='tender'});}catch(e){if(!/stock insuffisant/i.test(e.message))throw e;reason=e.message;}
   if(!reason)throw Error('Stock suffisant : utiliser la reprise normale avec création du BL');
   // Keep the normal ERP worker on hold: a forced label is not a preparation order.
   await db.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[o.id]);
   const actor=(await db.query("SELECT user_email FROM audit WHERE action='resolution.requested' AND detail->>'id'=$1 ORDER BY id DESC LIMIT 1",[j.id])).rows[0]?.user_email;
   if(!actor)throw Error('Auteur de la dérogation non identifié');
   const stockOverride={requestedBy:actor,at:new Date().toISOString(),reason,fingerprint:await shipmentFingerprint(db,o)};
   const queued=await regenerateProductionLabels(db,{ids:[o.id],batchId:'resolution-'+j.id,stockOverride});
   if(queued.skipped.length)throw Error(queued.skipped[0].reason);
   await db.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'label.stock_override',$2)",[actor,JSON.stringify({orderId:o.id,...stockOverride})]);
   await update(j.id,'waiting','Étiquette forcée · stock insuffisant',{pdfOnly:true,labelRequested:true,stockOverride:true});return null;
  }
  if(j.action==='recover-pdf'){
   const c=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
   if(c?.status==='ready')return {message:'Le PDF est déjà disponible dans V3.'};
   if(c?.carrier!=='gofo'||!c.result?.reference)throw Error('Création à vérifier chez le transporteur : aucune nouvelle expédition ne sera envoyée.');
   await db.query("UPDATE carrier_jobs SET status='awaiting_pdf',attempts=0,updated_at=now()-interval '15 seconds' WHERE order_id=$1",[o.id]);await update(j.id,'waiting','Récupération du PDF existant',{pdfOnly:true,labelRequested:true});return null;
  }
  if(j.action==='refresh'&&b.type==='weight-unit'&&(!b.provider||b.provider==='Erplain')){
   if(!String(b.sku||'').trim())throw Error('SKU du diagnostic requis');
   await stage('Relecture du poids Erplain sans préparation');await api.verify();
   const found=await readOrderSku(b.sku.trim());if(!found.usable)return {...found,provider:'Erplain',readOnly:true,diagnosticOnly:true,message:'Diagnostic Erplain actualisé : '+found.status};
   return refreshWeightUnitDiagnostics(db,o,b.sku.trim(),found.variant);
  }
  if(j.action==='refresh'){
   if(b.confirmMissingBc===true){await stage('Vérification du BC absent avant reprise');return {...await recoverMissingBc(db,api,o,{bcId:b.missingBcId,reference:b.orderReference,confirmed:true,resolutionId:j.id,stage}),checks:await recheckOrders(db,[o.id])};}
   if(b.type==='customer'){await stage('Recherche du client existant dans Erplain');return {...await refreshCustomerIdentity(db,api,o,{confirmAbsent:b.confirmCustomerAbsent===true,customerNumber:b.customerNumber,requestId:j.id}),checks:await recheckOrders(db,[o.id])};}
   if(b.provider==='Shopify'){
    await stage('Lecture de la commande source dans Shopify');
    return {...await diagnoseShopify(o.id),readOnly:true};
   }
   if(['GLS','GOFO'].includes(b.provider)){
    await stage('Lecture du suivi '+b.provider+' auprès du transporteur');
    return {...await diagnoseCarrier(o.id,b.provider),readOnly:true};
   }
   if(b.provider==='TEMU'){
    if(o.channel!=='temu')throw Error('Cette commande ne provient pas de TEMU');
    if(typeof refreshTemuDiagnostic!=='function')throw Error('Lecture TEMU indisponible : connexion à vérifier');
    await stage('Lecture de la commande et des expéditions dans TEMU');
    return {...await refreshTemuDiagnostic(o.reference),readOnly:true};
   }
   if(o.erp_live?.bc?.id&&!o.partial_mode&&['stock','api-stock','api-incomplete','bc','unknown','preparation'].includes(b.type)){
    await stage('Relecture du BC et des BL existants dans Erplain');
    const documents=await refreshErplainDocuments(db,api,o.id,{resolutionId:j.id});
    if(documents.identityIssue)throw Error(documents.message);
   }
   if(o.source_payload?.erplainImported){await stage('Lecture du BC, des produits et des BL Erplain');await refreshManualOrder(db,api,o);}
   if(b.sku){await stage('Relecture du SKU dans Erplain LIVE');await api.verify();const found=await readOrderSku(b.sku);if(found.usable)await bindProduct(db,found.variant);else return {...found,message:'Diagnostic Erplain actualisé : '+found.status};}
   else if(b.type.startsWith('api-')){await stage('Vérification de la connexion Erplain LIVE');await api.verify();}
   return {message:'Données relues. Les problèmes encore présents restent affichés.',checks:await recheckOrders(db,[o.id])};
  }
  if(j.action==='resume'){
   if(!usesRecordedBc(o)&&o.source_payload?.marketplacePendingCorrection)throw Error('Commande modifiée sur la plateforme : vérifier les nouvelles données avant reprise');
   if(o.archived||o.erp_live?.bc?.status==='cancelled'||o.tracking_status==='cancelled')throw Error('Commande archivée ou annulée : reprise non autorisée. Vérifier les documents existants avant toute décision.');
   if(o.source_payload?.erplainImported)await refreshManualOrder(db,api,o);
   if(o.archived||o.erp_live?.bc?.status==='cancelled'||o.tracking_status==='cancelled')throw Error('Commande archivée ou annulée : reprise non autorisée. Vérifier les documents existants avant toute décision.');
   if(o.partial_mode||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Utiliser le suivi de la livraison partielle ou expédiée');
   const carrier=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
   const existing=carrier&&(['ready','pending','creating','awaiting_pdf'].includes(carrier.status)||carrier.result||carrier.tracking?.length);
   if(!existing){await stage('Recalcul de la préparation');const checks=await recheckOrders(db,[o.id]);if(!checks[0]?.prepared)throw Error(checks[0]?.problem||'Préparation protégée : vérifier la commande');}
   if(carrier?.status==='review'||carrier?.status==='failed'&&(carrier.result||carrier.tracking?.length))throw Error('Création transport à vérifier : récupérer la création existante avant reprise');
   if(o.erp_live?.bc?.id){
    await api.verify();const bcResult=await api.request(`query V3ResolutionResumeBC($id:ID!){Order(id:$id){${o.source_payload?.erplainImported?manualOrderFields:'id status line_items{type quantity variant{sku}}'}}}`,{id:String(o.erp_live.bc.id)});
    const bc=checkedResumeBc(bcResult,o.erp_live.bc);
    const desired=usesRecordedBc(o)?[]:await readComparisonLines(db,o);
    const total=rows=>{const sums=new Map();for(const l of shippingProductLines(rows)){const sku=l.sku||l.variant?.sku;sums.set(sku,(sums.get(sku)||0)+Number(l.quantity));}return JSON.stringify([...sums].sort());};
    if(!usesRecordedBc(o)&&total(desired)!==total(resolutionBcLines(o,bc)))throw Error('Commande V3 et BC différents : comparer les produits et quantités avant de générer l’étiquette');
   }
   const needsPreparationCheck=(!existing||j.result?.regenerateExisting)&&(!o.erp_live?.bl?.id||!o.erp_live?.stockCheckedAt||!o.erp_live?.verifiedAt||(!usesRecordedBc(o)&&o.erp_live?.labelPreparationFingerprint!==await shipmentFingerprint(db,o)));
   await db.transaction(async tx=>{
    await tx.query('UPDATE orders SET resolution_pending_resume=false WHERE id=$1',[o.id]);
    await tx.query("INSERT INTO erp_live_jobs(order_id,status) VALUES($1,'pending') ON CONFLICT(order_id) DO UPDATE SET status=CASE WHEN erp_live_jobs.status='review' OR erp_live_jobs.status='complete' AND $2 THEN 'pending' ELSE erp_live_jobs.status END,error=CASE WHEN erp_live_jobs.status='review' OR erp_live_jobs.status='complete' AND $2 THEN null ELSE erp_live_jobs.error END",[o.id,needsPreparationCheck]);
    await tx.query("UPDATE resolution_jobs SET status='waiting',stage='Vérification Erplain avant étiquette',result=$2,updated_at=now() WHERE id=$1",[j.id,JSON.stringify({...j.result,resume:true,labelRequested:!!existing&&!j.result?.regenerateExisting})]);
   });return null;
  }
  throw Error('Action non prise en charge');
 }
 async function assertOrderEditable(o,allowReady=false){
  if(o.archived||o.erp_live?.bc?.status==='cancelled'||o.tracking_status==='cancelled'||o.partial_mode||['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Livraison partielle ou déjà expédiée : utiliser le suivi de cette livraison');
  const c=(await db.query('SELECT * FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];
  if(c&&!(allowReady&&c.status==='ready'&&c.environment==='production')&&(c.status!=='failed'&&c.status!=='superseded'||c.result||c.tracking?.length))throw Error('Expédition existante ou incertaine : vérifier le transport avant de modifier cette commande');
  if((await db.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND (status='processing' OR status='pending' AND NOT $2)",[o.id,o.resolution_pending_resume||false])).rows.length)throw Error('Traitement Erplain en cours : attendre sa fin');
 }
 return {
  followWaiting:()=>waiting.run(),
  get running(){return running;},
  async routes({p,url,req,res,user,body,json,permitted}){
   if(p==='/api/resolutions/context'&&req.method==='GET'){json(res,200,await context(db,directory,url.searchParams.get('id')));return true;}
   if(p==='/api/resolutions/job'&&req.method==='GET'){const j=(await db.query("SELECT id,order_id,action,status,stage,result,error,created_at,updated_at,state_since,to_jsonb(resolution_jobs)->'payload'->>'carrier' AS requested_carrier FROM resolution_jobs WHERE id=$1",[url.searchParams.get('id')])).rows[0];if(!j)throw Error('Intervention introuvable');json(res,200,j);return true;}
   if(p!=='/api/resolutions'||req.method!=='POST')return false;
   permitted(user,['admin','manager']);const b=validateResolution(await body(req));json(res,202,await queueResolutionRequest(db,b,user));return true;
  },
  async run(){await reconcileCompletedBlResumptions(db);if(running)return;running=true;let j;
   try{
    if(Date.now()-lastWeightStatusRefresh>=60000){await reconcileVerifiedWeights(db);lastWeightStatusRefresh=Date.now();}
    await reconcileCompletedErpReviews(db);
    await reconcileResolvedStockReviews(db);
    await reconcileMonetaryPreviews(db);
    await db.query(`UPDATE resolution_jobs r SET status='waiting',error=null,stage='Recontrôle après correction du numéro BC',updated_at=now() FROM erp_live_jobs e,orders o WHERE r.order_id=e.order_id AND o.id=r.order_id AND r.status='review' AND r.stage='Erplain à compléter' AND (r.error LIKE '%already in use%' OR r.error='BC · Taux de TVA source à préciser') AND e.status='complete' AND e.error IS NULL AND o.erp_live->'bc'->>'status'='active' AND o.erp_live->>'verifiedAt' IS NOT NULL AND o.erp_live->>'stockCheckedAt' IS NOT NULL`);
    j=(await db.query("SELECT * FROM resolution_jobs WHERE NOT EXISTS(SELECT 1 FROM orders suspended_order WHERE suspended_order.id=resolution_jobs.order_id AND (coalesce(suspended_order.suspension->>'active','false')='true' OR suspended_order.suspension ? 'erplainCancellation')) AND status='queued' ORDER BY (SELECT processing_priority_at FROM orders WHERE id=resolution_jobs.order_id) ASC NULLS LAST,updated_at,order_id LIMIT 1")).rows[0];if(!j){await pendingBlDiagnostics.run();await carrierPrevalidationDiagnostics.run();await importedLabelDiagnostics.run();return;}
    await update(j.id,'running','Vérification');await withShipmentLock(async()=>{try{
     const result=['choose-carrier','manual-temu-pricing'].includes(j.action)?await withShipmentLock(()=>apply(j),['temu-order:'+(await db.query('SELECT reference FROM orders WHERE id=$1',[j.order_id])).rows[0].reference]):await apply(j);if(!result)return;
     if(result.readOnly){const errors=result.errors||[],provider=result.provider||j.payload.provider||'transporteur';await update(j.id,errors.length?'review':'complete',j.action==='compare-bc'?result.message:(errors.length?'Lecture '+provider+' partielle':'Informations '+provider+' actualisées'),result,errors.length?errors.map(x=>x.message).join(' ; '):null);return;}
     if(await continueSuccessfulCorrection(j,result,{
      recheck:ids=>recheckOrders(db,ids),resume:apply,
      review:(error,details)=>update(j.id,'review','Correction enregistrée · suite bloquée',details,error)
     }))return;
     await update(j.id,'complete','Terminé',result);
    }catch(e){await failure(j,e);}
    },['stock-mutations']);
   }catch(e){if(j)await failure(j,e);}finally{running=false;}
  }
 };
}
