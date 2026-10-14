import {restoreImportBcAmounts} from './import-bc-commercial.mjs';
import {retirePostBcCommercialControls} from './post-bc-control-recovery.mjs';
import {invoiceCustomerType} from './invoice-customer-policy.mjs';
import {usesRecordedBc,readRecordedBc,recordedBcFingerprint,verifyRecordedOrSourceTotals,withRecordedOrSourceGuard,assertRecordedBc} from './existing-bc-execution.mjs';
import {prepareIncompleteTemuCatalogue} from './temu-source-catalogue.mjs';
import {preserveSubstitutionLabels} from './preserve-substitution-labels.mjs';
import {ensureMissingProduct,reconcileCreationAttempt,sourceProductName,readCreationSku,createBlockedMissingProducts,productCreationBlock} from './missing-product-creation.mjs';
import {bindProduct} from './product-bindings.mjs';
import {selectedProductWeights,cacheSelectedProductWeights} from './selected-product-weights.mjs';
import {selectedPreparationRouting} from './selected-preparation-routing.mjs';
import {chooseDocumentStockVariant} from './document-stock-choice.mjs';
import {recoverInitialCommercialReviews} from './temu-command-recovery.mjs';
import {temuSellerTotals} from './temu-commercial-source.mjs';
import {resumeStaleHoldReviews} from './stale-hold-review.mjs';
import {resumeInitialTemuHolds} from './temu-initial-hold.mjs';
import {resumeTransientErplain,recordTransientFailure,closeTransientReviews} from './erplain-transient-recovery.mjs';
import {cancellationBlock,mutationBlock} from './erp-transient-policy.mjs';
import {confirmDeliveryReady} from './bl-ready.mjs';
import {historicalPreparationProof} from './historical-stock-proof.mjs';
import {currentMappingLine,currentMappingFingerprint,mappingSelectionFingerprint} from './current-mapping-line.mjs';
import {alignMappedBc} from './mapping-bc-alignment.mjs';
import {readPreservedHistoricalBc} from './historical-bc-pricing.mjs';
import {alignHistoricalSourceVat,queueSourceVatReviews} from './historical-source-vat.mjs';
import {normalizeHistoricalDraft} from './historical-bl-draft.mjs';
import {resumeTemuFinancialReviews} from './financial-review-recovery.mjs';
import {resumeAcceptedCommercialReviews} from './commercial-tolerance-recovery.mjs';
import {scheduleStockChecks,stockCheckFailure,stockNotFound,stockCheckConfirmed,closeStockChecks} from './stock-auto-reconciliation.mjs';
import {claimStockCreation,canCreateStock,recordStockCreationOutcome,stockFailureMessage} from './stock-creation-claim.mjs';
import {refreshManualOrder} from './manual-erplain-orders.mjs';
import {erplainCustomerLabel} from './customer-identity.mjs';
import {reconcileFullStock} from './stock-cycle.mjs';
import {publishHistoricalBl,assertHistoricalBlNumber} from './bl-numbering.mjs';
import {publishIncrementalBc} from './bc-numbering.mjs';
import {ensureTemuBcPricing,temuBcPricingLoader} from './temu-bc-pricing.mjs';
import {loadShopifyConfig,shopifyCollector} from './marketplace-collection.mjs';
import {buildBcPricing,verifyBcPricing,verifySourceCommercialTotals,sourceCurrency} from './bc-pricing.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {assertBcLines,bcAddresses,preparationBlock,uncertainBc} from './bc-authorization.mjs';
import {initializePriority,erplainEligible,priorityOrder} from './order-priority.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {documentMetadata,technicalMarker,recoverOrder} from './erplain-document-metadata.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {assertLiveCapacity} from './live-capacity.mjs';
import {assertFullOrderStock,assertStockResolved} from './stock-gate.mjs';
import {readFile} from 'node:fs/promises';

import path from 'node:path';

import {erplainAccount} from './erplain-accounts.mjs';

import {convertedQuantity,addressIssue} from './domain.mjs';

export async function initializeErplainLive(db){await initializePriority(db);await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_live JSONB NOT NULL DEFAULT '{}'; CREATE TABLE IF NOT EXISTS erp_live_jobs(order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,status TEXT DEFAULT 'pending',error TEXT,updated_at TIMESTAMPTZ DEFAULT now());`);if(db.recoverInterrupted!==false)await db.query("UPDATE erp_live_jobs SET status='review',error='Traitement interrompu : rapprocher les documents avant reprise' WHERE status='processing'");}

export async function queueErplainLive(db,ids){if(!Array.isArray(ids)||!ids.length||ids.length>10000)throw new Error('Sélection de 1 à 10000 commandes requise');return (await db.query(`INSERT INTO erp_live_jobs(order_id) SELECT id FROM orders WHERE id=ANY($1::text[]) AND coalesce(suspension->>'active','false')<>'true' AND NOT (suspension ? 'erplainCancellation') AND reference NOT LIKE 'DEMO-%' ON CONFLICT DO NOTHING RETURNING order_id`,[ids])).rows.length;}


function orderDate(value){if(/^\d{2}\/\d{2}\/\d{4}$/.test(value||'')){const [d,m,y]=value.split('/');return `${y}-${m}-${d}`;}if(/^\d{4}-\d{2}-\d{2}/.test(value||''))return value.slice(0,10);return new Date().toISOString().slice(0,10);}
// ERPLAIN reserves at activation and debits physical stock on the inherited BL.
// Every sales channel uses this input; persisted documents keep their own policy.
export function newSalesBcInput(o,priceLevelId){
 const addresses=bcAddresses(o.address);
 return {...o.documentMetadata,status:'unpublished',update_stock:true,customer:{id:String(o.erp_live.customer.id)},currency:o.currency,price_level:{id:String(priceLevelId)},dated_at:orderDate(o.source_date),...addresses,tax_type:o.pricing.tax_type,line_items:o.pricing.items,notes:o.channel==='tender'?String(o.source_payload?.notes??''):'Commande '+o.reference,internal_notes:technicalMarker(o)+' Prix source contrôlés avant publication. [V3-PRICING:1]'};
}
function assertNewBcStockPolicy(o,bc){if(o.erp_live.bcReservationPolicy==='erplain_bc_bl'&&bc.update_stock!==true)throw Error('BC · Politique de réservation différente de la création : rapprochement requis');}
export function creationResumeBlock(o){
 const state=o.erp_live||{};
 if(uncertainBc(o))return 'BC Erplain · Création à vérifier : aucun BC confirmé, aucune nouvelle création automatique';
 if(state.phase==='creating_stock'&&!state.stockDocument?.id)return state.stockLastFailure?.message||'Stock Erplain · Mouvement à vérifier : sortie non confirmée, aucune nouvelle déduction automatique';
 if(state.phase==='publishing_bl')return 'BL Erplain · Publication à vérifier : contrôler le BL et son mouvement de stock avant reprise';
 return null;
}
export function erplainLiveWorker(db,directory,{api=erplainAccount(directory,'live'),refreshTemuPricing=temuBcPricingLoader(db,directory)}={}){
 let running=false,activeBcOnlyOrderId=null;
 const save=async o=>db.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(o.erp_live)]);
 const fail=async(o,e)=>{let message=stockFailureMessage(o,e.message);message=await stockCheckFailure(db,o,e,message);if(o.erp_live?.phase==='creating_stock'&&!/sortie non confirmée, aucune nouvelle déduction automatique/.test(message)){o.erp_live.stockLastFailure={at:new Date().toISOString(),message};await save(o);}e=new Error(await recordTransientFailure(db,o,message,e));await db.query("UPDATE erp_live_jobs SET status='review',error=$2,updated_at=now() WHERE order_id=$1",[o.id,e.message]);await db.query("UPDATE orders SET erp_status='live_review' WHERE id=$1",[o.id]);};
 async function batchMutation(orders,phase,field,type,operation,input,selection){
  if(!orders.length)return;
  if(operation==='CreateOrder'){
   const snapshot=await api.request('query V3LiveCapacity { Orders(first:1){paginatorInfo{total}} }');
   const current=Number(snapshot.Orders?.paginatorInfo?.total);
   await db.query("INSERT INTO settings(key,value) VALUES('erplain_live_capacity',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify({current,planned:orders.length,limit:assertLiveCapacity(current,orders.length).limit,checkedAt:new Date().toISOString()})]);
   assertLiveCapacity(current,orders.length);
  }
  for(const o of orders){const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];const block=mutationBlock(fresh,{allowHeldBc:activeBcOnlyOrderId===o.id&&['CreateCustomer','CreateOrder'].includes(operation)});if(block){o.failed=true;await fail(o,new Error(block));continue;}if(operation==='CreateOrder')o.erp_live.bcReservationPolicy='erplain_bc_bl';o.erp_live.phase=phase;await save(o);}
  orders=orders.filter(o=>!o.failed);if(!orders.length)return;
  const q='mutation V3Batch('+orders.map((o,i)=>'$p'+i+':'+type+'!').join(',')+'){'+orders.map((o,i)=>`p${i}:${operation}(input:$p${i}){${selection}}`).join(' ')+'}';
  const result=await api.request(q,Object.fromEntries(orders.map((o,i)=>['p'+i,input(o)])),0,true);
  for(let i=0;i<orders.length;i++){if(!result['p'+i]?.id){orders[i].failed=true;await fail(orders[i],new Error(result._v3Errors?.find(e=>e.path?.[0]==='p'+i)?.message||'Réponse incomplète '+phase));continue;}orders[i].erp_live[field]=result['p'+i];orders[i].erp_live.phase=field+'_created';await save(orders[i]);}
  if(operation==='CreateOrder')await db.query("UPDATE settings SET value=jsonb_set(value,'{current}',to_jsonb((value->>'current')::int+$1::int)) WHERE key='erplain_live_capacity'",[orders.filter(o=>!o.failed&&o.erp_live.bc?.id).length]);
 }
 async function run({bcOnlyOrderId}={}){if(running)return;running=true;activeBcOnlyOrderId=bcOnlyOrderId||null;let working=[];
  try{
   if(!bcOnlyOrderId&&process.env.ERPLAIN_LIVE_WRITES==='1'&&process.env.MIGRATION_PREPARATION!=='1'){
    const {recheckOrders}=await import('./problem-resolution.mjs');
    await prepareIncompleteTemuCatalogue(db,api,{bind:v=>bindProduct(db,v)});
    await createBlockedMissingProducts(db,api,{blocked:mutationBlock,bind:v=>bindProduct(db,v),recheck:ids=>recheckOrders(db,ids)});
   }
   // Retry only the stock reconciliation checkpoint; never replay an uncertain mutation.
   if(!bcOnlyOrderId){await retirePostBcCommercialControls(db,api);await recoverInitialCommercialReviews(db);await resumeInitialTemuHolds(db);await resumeStaleHoldReviews(db,api);await closeStockChecks(db);await closeTransientReviews(db);await resumeTransientErplain(db,api);await resumeTemuFinancialReviews(db);await resumeAcceptedCommercialReviews(db,api);}
   if(!bcOnlyOrderId){await queueSourceVatReviews(db);await scheduleStockChecks(db);}
   const ids=await db.transaction(async tx=>{
    if(bcOnlyOrderId){
     const prior=(await tx.query('SELECT status FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[bcOnlyOrderId])).rows[0];
     if(prior?.status==='processing')throw Error('Traitement Erplain en cours');
     await tx.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[bcOnlyOrderId]);
     await tx.query("INSERT INTO erp_live_jobs(order_id,status) VALUES($1,'processing') ON CONFLICT(order_id) DO UPDATE SET status='processing',error=null,updated_at=now()",[bcOnlyOrderId]);
     return [bcOnlyOrderId];
    }
    const jobs=(await tx.query(`SELECT order_id FROM erp_live_jobs WHERE ${erplainEligible} ORDER BY ${priorityOrder('erp_live_jobs')} FOR UPDATE SKIP LOCKED LIMIT 10`)).rows;for(const j of jobs)await tx.query("UPDATE erp_live_jobs SET status='processing',updated_at=now() WHERE order_id=$1",[j.order_id]);return jobs.map(j=>j.order_id);
   });if(!ids.length)return;
   working=(await db.query('SELECT * FROM orders WHERE id=ANY($1::text[])',[ids])).rows;
   await api.verify();
   for(const o of working){const block=cancellationBlock(o);if(block){o.failed=true;await fail(o,new Error(block));}}
   working=working.filter(o=>!o.failed);
   for(const o of working.filter(uncertainBc)){try{const found=await recoverOrder(api,o);o.erp_live.bcReconciliation={status:found?'found':'missing',checkedAt:new Date().toISOString()};if(found){o.erp_live.bc={id:found.id,label:found.label,status:found.status};o.erp_live.phase='bc_created';}await save(o);}catch(e){o.failed=true;await fail(o,e);}}
   working=working.filter(o=>!o.failed);
   const currencies=JSON.parse(await readFile(path.join(directory,'currency-correspondence.json'),'utf8'));const references=JSON.parse(await readFile(path.join(directory,'live-workflow-references.json'),'utf8'));if(references.companyId!==100174||!references.locationId||!references.priceLevelId)throw Error('Références LIVE non vérifiées');
   const bindings=new Map((await db.query('SELECT * FROM erplain_product_bindings')).rows.map(b=>[b.sku,b]));
   let taxCodes;
   const valid=[];
   for(const o of working){try{
 const lines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE order_id=$1',[o.id,o.channel])).rows;
 o.selectedSourceLines=lines;
 if(!usesRecordedBc(o))await restoreImportBcAmounts(db,o,lines);
 if(usesRecordedBc(o)&&!o.source_payload?.erplainImported){const execution=await readRecordedBc(api,o);assertNewBcStockPolicy(o,execution.bc);o.items=execution.items;o.erp_live.bc={...o.erp_live.bc,...execution.bc};o.erp_live.pricing=execution.pricing;o.currency=execution.bc.currency;if(execution.bc.status==='unpublished')o.pricing=execution.pricing;await save(o);valid.push(o);continue;}
 if(o.source_payload?.erplainImported){await refreshManualOrder(db,api,o);if(o.source_payload.account!=='live'||!o.erp_live?.bc?.id||!o.erp_live.importedItems?.length)throw Error('Actualiser la commande Erplain avant préparation');o.items=o.erp_live.importedItems;valid.push(o);continue;}
 if(o.erp_live?.equivalentItems){if(!o.erp_live.bc?.id)throw new Error('BC absent pour les équivalents');o.items=o.erp_live.equivalentItems;valid.push(o);continue;}



 await ensureTemuBcPricing(db,o,lines,refreshTemuPricing);
 const currencyCode=sourceCurrency(o);const currency=currencies.rows.find(c=>c.label.toUpperCase()===currencyCode&&c.liveId);if(!currency)throw new Error('Devise non disponible dans Erplain LIVE : '+currencyCode);o.currency={id:String(currency.liveId),label:currency.label};

   if(o.channel==='shopify'&&!o.erp_live.bc&&(typeof o.source_payload?.taxes_included!=='boolean'||lines.some(l=>!Array.isArray(l.source_payload?.discount_allocations)||!Array.isArray(l.source_payload?.tax_lines)))){
    const fresh=await shopifyCollector(await loadShopifyConfig(directory)).order(o.source_payload?.id);
    if(fresh.cancelled_at||fresh.currency!==currencyCode||fresh.line_items.length!==lines.length)throw Error('Shopify · Commande modifiée : rapprocher les prix et quantités');
    const updates=lines.map(l=>{const hits=fresh.line_items.filter(x=>String(x.id)===String(l.source_payload?.id));if(hits.length!==1||hits[0].sku!==l.source_sku||Number(hits[0].quantity)!==Number(l.quantity))throw Error('Shopify · Ligne modifiée : '+l.source_sku);return {...l.source_payload,...hits[0]};});
    o.source_payload={...o.source_payload,taxes_included:fresh.taxes_included,total_price:fresh.total_price,shipping_lines:fresh.shipping_lines,pricingRefreshedAt:new Date().toISOString()};
    await db.transaction(async tx=>{await tx.query('UPDATE orders SET source_payload=$2 WHERE id=$1',[o.id,JSON.stringify(o.source_payload)]);for(let i=0;i<lines.length;i++){lines[i].source_payload=updates[i];await tx.query('UPDATE lines SET source_payload=$2 WHERE id=$1',[lines[i].id,JSON.stringify(updates[i])]);}});
   }
   let choiceDocument=null;
   if(o.erp_live?.bc?.id){
    const result=await api.request('query V3BcVariantIdentity($id:ID!){Order(id:$id){id line_items{type quantity variant{id sku} location{id}}}}',{id:String(o.erp_live.bc.id)});
    choiceDocument=result.Order;if(String(choiceDocument?.id)!==String(o.erp_live.bc.id)||!Array.isArray(choiceDocument.line_items))throw Error('BC · Identité des produits du document non vérifiée');
   }
   const items=await Promise.all(lines.map(async l=>{

    const {sku,quantity}=currentMappingLine(l,o.channel);

    if(!sku)throw Error('BC · Mapping manquant : '+l.source_sku);
    const binding=bindings.get(sku);
    let lookup=await api.request('query V3BcLookup($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku active weight_amount weight_unit tax_codes{id} product{id active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:sku}});
    if(!lookup.Variants?.data||lookup.Variants.paginatorInfo?.hasMorePages)throw Error('BC · Vérification produit Erplain LIVE incomplète : '+sku);
    if(!lookup.Variants.data.some(v=>v.sku===sku)){
     if(binding||choiceDocument)throw Error('BC · Référence liée absente : vérifier le produit existant '+sku);
     const created=await ensureMissingProduct(db,api,{sku,label:sourceProductName(l),guard:async()=>{
      const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
      const block=mutationBlock(fresh,{allowHeldBc:activeBcOnlyOrderId===o.id});
      if(block||productCreationBlock(fresh,{resolution:activeBcOnlyOrderId===o.id}))throw Error(block||'Commande protégée : création suspendue');
     }});
     await bindProduct(db,created.variant);
     lookup={Variants:{data:await readCreationSku(api,sku),paginatorInfo:{hasMorePages:false}}};
    }
    const choice=chooseDocumentStockVariant(lookup.Variants.data,{sku,locationId:references.locationId,document:choiceDocument,variantId:binding?.live_variant_id});
    const product=await reconcileCreationAttempt(db,choice.variant),target={targetVariantId:product.id};
    // Keep the selected physical variant available to the preparation's weight
    // reconciliation. A global SKU weight must not silently choose another one.
    o.selectedProducts??={};o.selectedProducts[sku]=product;


    return {location:{id:String(references.locationId)},variant:{id:String(target.targetVariantId)},quantity,price:0,description:sku};

   }));assertBcLines(items);
   o.selectedSourceLines=lines;
 if(!usesRecordedBc(o))await restoreImportBcAmounts(db,o,lines);


    o.items=items;o.erp_live=o.erp_live||{};
    // Existing documents retain their commercial history. New/recoverable priced drafts
    // must pass source validation before any customer, BC or stock mutation.
    if(o.channel==='temu'||!o.erp_live.bc||o.erp_live.pricing){
     if(!taxCodes){const t=await api.request('query V3PricingTaxes {TaxCodes(first:200){data{id active tax_rates{rate}} paginatorInfo{hasMorePages}}}');if(!t.TaxCodes?.data||t.TaxCodes.paginatorInfo?.hasMorePages)throw Error('BC · Catalogue TVA incomplet');taxCodes=t.TaxCodes.data;}
     let eurExchangeRate;
     if(currencyCode!=='EUR'){
      const result=await api.request('query V3PricingCurrencies {Currencies(first:200){data{id label exchange_rate default} paginatorInfo{hasMorePages}}}');
      const list=result.Currencies;if(!list?.data||list.paginatorInfo?.hasMorePages||!list.data.some(c=>c.default&&c.label==='EUR'))throw Error('BC · Conversion en euros à vérifier dans Erplain');
      const current=list.data.find(c=>String(c.id)===String(currency.liveId)&&c.label===currencyCode);
      if(!current||!(Number(current.exchange_rate)>0))throw Error('BC · Taux de change Erplain absent : '+currencyCode);
      eurExchangeRate=Number(current.exchange_rate);
     }
     o.pricing=o.channel==='temu'&&o.erp_live.bc?.id&&o.erp_live.equivalentOriginalLines?.length?temuSellerTotals(o):buildBcPricing(o,lines,items,taxCodes,{eurExchangeRate});
     o.erp_live.pricing={...o.pricing,items:undefined,status:'pending'};await save(o);
    }
    valid.push(o);
   }catch(e){await fail(o,e);}}
   working=valid;if(!working.length)return;
   await api.verify();
   // Recover a persisted BC before deciding whether any creation is needed.
   const missing=working.filter(o=>!o.erp_live.bc);
   for(const o of missing){const found=await recoverOrder(api,o);if(found){o.erp_live.bc={id:found.id,label:found.label};o.erp_live.phase='bc_created';if(usesRecordedBc(o)){const execution=await readRecordedBc(api,o);assertNewBcStockPolicy(o,execution.bc);o.items=execution.items;o.erp_live.bc={...o.erp_live.bc,...execution.bc};o.erp_live.pricing=execution.pricing;if(execution.bc.status==='unpublished')o.pricing=execution.pricing;else delete o.pricing;delete o.selectedProducts;delete o.selectedSourceLines;}await save(o);}}
   for(const o of working)o.documentMetadata=await documentMetadata(o,directory);
   // The recorded BC supplies execution lines; no mapping, VAT or price alignment.
   for(const o of working.filter(o=>!bcOnlyOrderId&&o.erp_live.phase==='creating_stock'&&!o.erp_live.stockDocument?.id)){try{const stock=await withRecordedOrSourceGuard(api,o,()=>o.channel==='temu'?temuSellerTotals(o):o.source_payload?.erplainImported?o.erp_live.importedCommercialSource:o.pricing||o.erp_live.pricing,()=>reconcileFullStock(api,o,{allowCreate:canCreateStock(o),allowRecoverMissing:true,onAbsenceConfirmed:absenceProof=>recordStockCreationOutcome(db,o,{absenceProof}),beforeCreate:()=>claimStockCreation(db,o),onCreated:documentId=>recordStockCreationOutcome(db,o,{documentId}),onCreationFailure:error=>recordStockCreationOutcome(db,o,{error})}));if(!stock)throw stockNotFound();o.erp_live.stockDocument=stock;stockCheckConfirmed(o);o.erp_live.phase='bl_created';await save(o);}catch(e){o.failed=true;await fail(o,e);}}
   working=working.filter(o=>!o.failed);
   const safe=[];for(const o of working){const block=creationResumeBlock(o);if(block)await fail(o,new Error(block));else safe.push(o);}working=safe;if(!working.length)return;
   await batchMutation(working.filter(o=>!o.erp_live.bc&&!o.erp_live.customer),'creating_customer','customer','CustomerInput','CreateCustomer',o=>({label:erplainCustomerLabel(o),customer_number:'V3:'+o.id,customer_type:invoiceCustomerType({orderId:o.id,channel:o.channel,sourcePayload:o.source_payload}),notes:'Compte V3. Aucun email envoyé.'}),'id label');
   working=working.filter(o=>!o.failed);
   await batchMutation(working.filter(o=>!o.erp_live.bc),'creating_bc','bc','OrderInput','CreateOrder',o=>newSalesBcInput(o,references.priceLevelId),'id label update_stock');
   working=working.filter(o=>!o.failed);if(!working.length)return;
   // Number the persisted BC without comparing its commercial fields to a source.
   // Retrying an API failure reuses the same BC; it never creates another one.
   for(const o of working.filter(o=>o.pricing)){
    try{
     const historical=await readPreservedHistoricalBc(api,o,usesRecordedBc(o)?null:o.channel==='temu'?temuSellerTotals(o):null);
     const actual=historical?.bc||await publishIncrementalBc(api,o.erp_live.bc.id,{datedAt:orderDate(o.source_date),expectedStockPolicy:o.erp_live.bcReservationPolicy==='erplain_bc_bl'?true:undefined,verify:bc=>usesRecordedBc(o)?assertRecordedBc(o,bc):verifyBcPricing(bc,o.pricing),lock:fn=>withShipmentLock(fn,['erplain-bc-numbering'])});
     const confirmed=historical?.confirmed||await verifyRecordedOrSourceTotals(api,o,actual,()=>o.pricing);o.erp_live.bc={...o.erp_live.bc,id:actual.id,label:actual.label,status:actual.status};
     o.erp_live.pricing={...o.erp_live.pricing,status:'verified',error:null,confirmed,verifiedAt:new Date().toISOString()};await save(o);
    }catch(e){o.failed=true;o.erp_live.pricing={...o.erp_live.pricing,status:'blocked',error:e.message};await save(o);await fail(o,e);}
   }
   working=working.filter(o=>!o.failed);if(!working.length)return;
   for(const o of working.filter(usesRecordedBc)){try{if(!o.source_payload?.erplainImported){const execution=await readRecordedBc(api,o);assertNewBcStockPolicy(o,execution.bc);o.items=execution.items;o.erp_live.bc={...o.erp_live.bc,...execution.bc};o.erp_live.pricing=execution.pricing;}delete o.pricing;await save(o);}catch(e){o.failed=true;await fail(o,e);}}
   working=working.filter(o=>!o.failed);if(!working.length)return;
   // Reconcile weights only after the BC is available. Missing weight must not
   // prevent an otherwise valid BC, but cannot borrow another variant's cache.
   for(const o of working.filter(o=>o.selectedProducts)){
    try{
     const check=await api.request('query V3SelectedProductIdentity($id:ID!){Order(id:$id){id line_items{type quantity variant{id sku} location{id}}}}',{id:String(o.erp_live.bc.id)});
     if(String(check.Order?.id)!==String(o.erp_live.bc.id))throw Error('BC · Identité produit non confirmée');
     const physical=shippingProductLines(check.Order.line_items);
     const weightLines=usesRecordedBc(o)?[...new Set(physical.map(l=>String(l.variant.id)))].map(id=>{
      const item=physical.find(l=>String(l.variant.id)===id),sku=item.variant.sku||Object.keys(o.selectedProducts).find(k=>String(o.selectedProducts[k].id)===id);
      const source=o.selectedSourceLines.find(l=>[l.source_sku,l.target_sku,l.mapped_sku].includes(sku));
      return {...source,target_sku:sku,target_quantity:physical.filter(l=>String(l.variant.id)===id).reduce((n,l)=>n+Number(l.quantity),0)};
     }):o.selectedSourceLines;
     const plan=selectedProductWeights(weightLines,o.selectedProducts,physical);
     await cacheSelectedProductWeights(db,o.id,plan);
     const route=await selectedPreparationRouting(db,o.id,plan);
     if(!route.preserved){o.weight_kg=route.weight;if(!route.missing){o.parcel_count=route.parcels;o.carrier=route.carrier;}o.erp_live.labelPreparationFingerprint=null;await save(o);}
     if(plan.missing.length)throw Error(plan.missing.map(x=>x.sku+' · '+x.message).join(' ; '));
    }catch(e){o.failed=true;await fail(o,e);}
   }
   working=working.filter(o=>!o.failed);if(!working.length)return;
   // Explicit stock override stops after the BC, including when a BL already exists.
   // Never reach shipping creation, publication or stock removal in this mode.
   if(bcOnlyOrderId){
    for(const o of working)await fail(o,new Error('En attente de stock : BC disponible, préparation du BL suspendue'));
    return;
   }
   const ready=[];for(const o of working){const block=preparationBlock(o);if(block){o.erp_live.preparationBlocked=block;await save(o);await fail(o,new Error(block));}else ready.push(o);}working=ready;if(!working.length)return;
   const needBl=working.filter(o=>!o.erp_live.bl);
   if(needBl.length){const current=await api.request('query V3FindShipping{'+needBl.map((o,i)=>`p${i}:Order(id:${Number(o.erp_live.bc.id)}){shipping_orders(first:100){data{id label status update_stock} paginatorInfo{hasMorePages}}}`).join(' ')+'}');for(let i=0;i<needBl.length;i++){const hits=current?.['p'+i]?.shipping_orders?.data;if(!Array.isArray(hits)||current?.['p'+i]?.shipping_orders?.paginatorInfo?.hasMorePages!==false)throw new Error('API Erplain · Réponse BL incomplète : aucune nouvelle création');if(hits.length>1)throw new Error('BL multiples à contrôler');if(hits.some(bl=>!bl?.id))throw new Error('API Erplain · Réponse BL incomplète : identifiant absent');if(hits.length){needBl[i].erp_live.bl=hits[0];await save(needBl[i]);}}}
   // Check and create/publish each BL sequentially so stock consumed by one order
   // is visible when validating the following order. Labels wait for verified BL quantities.
   for(const o of working){
    if(o.failed)continue;
    // Older published BLs predate the stock gate. Read and validate them without
    // publishing again or creating a second stock movement.
    if(o.erp_live.bl?.status==='pending'||o.source_payload?.erplainImported&&['make_the_shipment','in_preparation','ready_to_ship'].includes(o.erp_live.bl?.status)){
     if(!o.erp_live.stockCheckedAt)await withShipmentLock(async()=>{try{
      await assertStockResolved(db,o.items.map(l=>l.variant.id),{orderId:o.id});
      const r=await api.request('query V3ValidateExistingBL($bc:ID!,$bl:ID!){Order(id:$bc){id status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}} ShippingOrder(id:$bl){id status line_items{type quantity location{id} variant{id sku}}}}',{bc:String(o.erp_live.bc.id),bl:String(o.erp_live.bl.id)});
      if(!r.Order?.line_items?.length||!r.ShippingOrder?.line_items?.length)throw Error('API Erplain · Réponse BC/BL incomplète');
      if(r.Order.status!=='active'||!(o.source_payload?.erplainImported?['pending','make_the_shipment','in_preparation','ready_to_ship']:['pending']).includes(r.ShippingOrder.status))throw Error('Statut BC/BL modifié : vérifier les documents Erplain');
      const totals=rows=>{const m=new Map();for(const l of shippingProductLines(rows)){const k=String(l.variant?.id)+':'+String(l.location?.id);m.set(k,(m.get(k)||0)+Number(l.quantity));}return JSON.stringify([...m].sort());};
      if((!o.erp_live.pendingBlIds?.length&&totals(o.items)!==totals(r.Order.line_items))||totals(o.items)!==totals(r.ShippingOrder.line_items))throw Error('Écart BC/BL : références ou quantités à contrôler');
      if(r.Order.update_stock===true){
       o.erp_live.historicalStockProof=await historicalPreparationProof(api,o);
      }else if(o.source_payload?.erplainImported){
       if(typeof r.Order.update_stock!=='boolean')throw Error('API Erplain · Politique de stock du BC non reçue');
       if(r.Order.update_stock===false){
        // Reconcile first: stock may already have been deducted before a lost response.
        let stock=await reconcileFullStock(api,o,{allowCreate:false});
        if(!stock){
         if(!canCreateStock(o))throw Error('Stock Erplain : sortie non confirmée, aucune nouvelle déduction automatique');
         assertFullOrderStock(o.erp_live.pendingBlIds?.length?o.erp_live.importedItems.map(item=>({...r.Order.line_items.find(l=>String(l.variant?.id)===String(item.variant.id)&&String(l.location?.id)===String(item.location.id)),quantity:item.quantity})):r.Order.line_items);
         o.erp_live.phase='creating_stock';o.erp_live.stockPendingVariants=o.items.map(l=>String(l.variant.id));await save(o);
         stock=await withRecordedOrSourceGuard(api,o,()=>o.erp_live.importedCommercialSource,()=>reconcileFullStock(api,o,{allowCreate:true,beforeCreate:()=>claimStockCreation(db,o),onCreated:documentId=>recordStockCreationOutcome(db,o,{documentId}),onCreationFailure:error=>recordStockCreationOutcome(db,o,{error})}));
         if(!stock)throw Error('Stock Erplain : mouvement non confirmé');
        }
        o.erp_live.stockDocument=stock;o.erp_live.phase='bl_created';await save(o);
       }
      }else assertFullOrderStock(o.erp_live.pendingBlIds?.length?o.erp_live.importedItems.map(item=>({...r.Order.line_items.find(l=>String(l.variant?.id)===String(item.variant.id)&&String(l.location?.id)===String(item.location.id)),quantity:item.quantity})):r.Order.line_items);
      o.erp_live.stockCheckedAt=new Date().toISOString();
      o.erp_live.existingBlValidation={at:o.erp_live.stockCheckedAt,blId:o.erp_live.bl.id,source:'current_stock',stockMovementCreated:false};
      await save(o);
     }catch(e){o.failed=true;await fail(o,e);}});
     continue;
    }
    if(o.erp_live.bl&&o.erp_live.bl.status!=='unpublished')continue;
    await withShipmentLock(async()=>{try{
     const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];const blocked=!fresh||fresh.archived?'Commande indisponible':fresh.resolution_pending_resume?'Préparation suspendue : validation requise':cancellationBlock(fresh);if(blocked)throw Error(blocked);
     // Retain the exact served PDF and SKU copy before the BL changes its context.
     await preserveSubstitutionLabels(db,o.id);
     await assertStockResolved(db,o.items.map(l=>l.variant.id),{orderId:o.id});
     const snapshot=await api.request('query V3CheckFullStock($id:ID!){Order(id:$id){id update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}}}',{id:String(o.erp_live.bc.id)});
     if(!snapshot.Order?.line_items?.length)throw new Error('Stock non vérifiable : BC sans lignes');
     if(typeof snapshot.Order.update_stock!=='boolean')throw new Error('Politique de stock du BC non vérifiée');
     {const totals=xs=>{const sums=new Map();for(const l of shippingProductLines(xs)){const key=String(l.variant?.id)+':'+String(l.location?.id);sums.set(key,(sums.get(key)||0)+Number(l.quantity));}return JSON.stringify([...sums].sort());};if(totals(o.items)!==totals(snapshot.Order.line_items))throw new Error('BC modifié : vérifier les produits et quantités avant BL');}
     const stockOnBc=snapshot.Order.update_stock===true;
     if(stockOnBc){if(o.erp_live.bl?.status==='unpublished')o.erp_live.bl=await normalizeHistoricalDraft(api,o);o.erp_live.historicalStockProof=await historicalPreparationProof(api,o,{beforeBlPublication:true});}
     else assertFullOrderStock(snapshot.Order.line_items);
     o.erp_live.stockCheckedAt=new Date().toISOString();await save(o);
     if(!o.erp_live.bl)await batchMutation([o],'creating_bl','bl','ShippingOrderFromInput','CreateShippingOrderFrom',v=>({Order:[String(v.erp_live.bc.id)]}),'id label status update_stock');
     if(o.failed)return;
     if(stockOnBc){if(o.erp_live.bl?.status==='unpublished')o.erp_live.bl=await normalizeHistoricalDraft(api,o);o.erp_live.historicalStockProof=await historicalPreparationProof(api,o,{beforeBlPublication:true});}
     if(o.erp_live.bl.status!=='unpublished'){const numbered=assertHistoricalBlNumber(await publishHistoricalBl(api,o.erp_live.bl.id));o.erp_live.bl={...o.erp_live.bl,...numbered};await save(o);}
     if(o.erp_live.bl.status==='unpublished'){
      if(o.erp_live.bl.update_stock!==false&&!(stockOnBc&&o.erp_live.bl.update_stock===true))throw new Error('Politique de stock BL inattendue : contrôle requis avant publication');
      o.erp_live.phase='publishing_bl';await save(o);
      const result={UpdateShippingOrder:await publishHistoricalBl(api,o.erp_live.bl.id,o.documentMetadata)};
      o.erp_live.bl=result.UpdateShippingOrder;
      if(stockOnBc){
       o.erp_live.phase='bl_created';await save(o);
       o.erp_live.historicalStockProof=await historicalPreparationProof(api,o);
      }else{
       o.erp_live.phase='creating_stock';o.erp_live.stockPendingVariants=o.items.map(l=>String(l.variant.id));await save(o);
       o.erp_live.stockDocument=await reconcileFullStock(api,o,{allowCreate:canCreateStock(o),allowRecoverMissing:true,onAbsenceConfirmed:absenceProof=>recordStockCreationOutcome(db,o,{absenceProof}),beforeCreate:()=>claimStockCreation(db,o),onCreated:documentId=>recordStockCreationOutcome(db,o,{documentId}),onCreationFailure:error=>recordStockCreationOutcome(db,o,{error})});if(!o.erp_live.stockDocument)throw stockNotFound();stockCheckConfirmed(o);
      }
      o.erp_live.phase='bl_created';await save(o);
     }
    }catch(e){o.failed=true;await fail(o,e);}});
   }
   working=working.filter(o=>!o.failed);if(!working.length)return;
   const checked=await api.request('query V3CheckDocuments{'+working.map((o,i)=>`p${i}:Order(id:${Number(o.erp_live.bc.id)}){id update_stock line_items{type quantity variant{id}} shipping_orders(first:10){data{id label line_items{type quantity variant{id}}}}}`).join(' ')+'}');
   for(let i=0;i<working.length;i++){
    const o=working[i],actual=checked['p'+i],bl=actual?.shipping_orders.data.find(b=>b.id===o.erp_live.bl.id);
    const totals=rows=>{const m=new Map();for(const l of shippingProductLines(rows))m.set(String(l.variant?.id),(m.get(String(l.variant?.id))||0)+Number(l.quantity));return JSON.stringify([...m].sort());};
    if(!actual||!bl||(!o.erp_live.pendingBlIds?.length&&totals(o.items)!==totals(actual.line_items))||totals(o.items)!==totals(bl.line_items)){await fail(o,new Error('Écart BC/BL : références ou quantités à contrôler'));continue;}
    try{const stockOnBc=actual.update_stock===true;if(stockOnBc){if(o.erp_live.bl?.status==='unpublished')o.erp_live.bl=await normalizeHistoricalDraft(api,o);o.erp_live.historicalStockProof=await historicalPreparationProof(api,o);}const stock=stockOnBc?null:await reconcileFullStock(api,o,{allowCreate:false});o.erp_live.bl=await confirmDeliveryReady(api,{bcId:o.erp_live.bc.id,blId:o.erp_live.bl.id,lines:o.items,stockOnBc,pendingBlScope:Boolean(o.source_payload?.erplainImported&&o.source_payload?.account==='live'&&o.erp_live.pendingBlIds?.length),stockDocument:stock,stockLabel:stock?.label,stockNotes:'LIVE : sortie de stock liée au BL '+bl.label});o.erp_live.stockPendingVariants=[];o.erp_live.phase='bl_ready';await save(o);}catch(e){await fail(o,e);continue;}
    const recorded=usesRecordedBc(o),mappingProof=recorded?recordedBcFingerprint({...o.erp_live.bc,line_items:o.items}):mappingSelectionFingerprint(o.selectedSourceLines,o.channel);if(!recorded&&await currentMappingFingerprint(db,o)!==mappingProof){await fail(o,new Error('Mapping modifié pendant la préparation : BC et BL à recontrôler'));continue;}o.erp_live.mappingPreparationFingerprint=mappingProof;if(recorded)o.erp_live.preparationAuthority={kind:'recorded_bc',bcId:String(o.erp_live.bc.id),fingerprint:mappingProof};
    assertHistoricalBlNumber(bl);o.erp_live.bl={...o.erp_live.bl,label:bl.label};o.erp_live.verifiedAt=new Date().toISOString();o.erp_live.labelPreparationFingerprint=await shipmentFingerprint(db,(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0]);await save(o);await db.query("UPDATE orders SET erp_status='live_created' WHERE id=$1",[o.id]);await db.query("UPDATE erp_live_jobs SET status='complete',error=null,updated_at=now() WHERE order_id=$1",[o.id]);
   }
  }catch(e){for(const o of working)await fail(o,e);}finally{running=false;activeBcOnlyOrderId=null;}
 }
 return {run:options=>withShipmentLock(()=>run(options),['erplain-live-workflow']),get running(){return running;}};
}
