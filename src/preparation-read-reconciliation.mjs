import {usesRecordedBc,recordedBcPricing,recordedBcFingerprint} from './existing-bc-execution.mjs';
import {createHash} from 'node:crypto';
import {currentMappingLine,currentMappingFingerprint} from './current-mapping-line.mjs';
import {shipmentFingerprint} from './label-stock-gate.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {assertDocumentIdle,readErplainDocuments} from './erplain-document-read.mjs';
import {historicalPreparationProof} from './historical-stock-proof.mjs';
import {verifySourceCommercialTotals,verifyBcLineIdentity} from './bc-pricing.mjs';
import {temuSellerTotals} from './temu-commercial-source.mjs';
import {deliveryTotals} from './bl-ready.mjs';
import {resolutionStateSql,currentResolutionState} from './historical-preparation-completion.mjs';

const digest=o=>createHash('sha256').update(JSON.stringify([o.source_payload,o.erp_live,o.address,o.weight_kg,o.issue,o.suspension,o.partial_mode,o.archived,o.resolution_pending_resume])).digest('hex');
const protectedOrder=o=>!o||o.archived||o.partial_mode||suspensionBlock(o)||o.source_payload?.marketplacePendingCorrection||o.source_payload?.visibilityHold||o.source_payload?.erplainValidationHold||o.erp_live?.mappingAlignmentAttempt?.status==='uncertain'||['creating_bc','creating_stock','publishing_bl'].includes(o.erp_live?.phase);
export function assertPreparationAddress(o,bc,bl){
 const normal=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();
 const country=v=>({FRA:'FR',FRANCE:'FR',DEU:'DE',GERMANY:'DE',DEUTSCHLAND:'DE',BEL:'BE',BELGIUM:'BE',BELGIQUE:'BE',ESP:'ES',SPAIN:'ES',ESPAÑA:'ES',ITA:'IT',ITALY:'IT',ITALIA:'IT'})[normal(v)]||normal(v);
 for(const document of [bc,bl])for(const [local,remote] of [['name','label'],['street','address_1'],['postal','postal_code'],['city','city'],['country','country']]){
  const expected=o.address?.[local],actual=document.shipping_address?.[remote],compare=local==='country'?country:normal;
  if(!normal(expected)||!normal(actual)||compare(expected)!==compare(actual))throw Error('Préparation · Adresse BC/BL différente ou incomplète : '+local);
 }
}
function skuTotals(rows){const m=new Map();for(const l of rows){if(l.type==='shipping_cost')continue;const sku=l.sku||l.variant?.sku,q=Number(l.quantity);if(!sku||!Number.isFinite(q)||q<=0)throw Error('Préparation · Références ou quantités reçues incomplètes');m.set(sku,(m.get(sku)||0)+q);}if(!m.size)throw Error('Préparation · Aucune ligne produit vérifiable');return JSON.stringify([...m].sort());}
async function assertRecheckIdle(db,id){await assertDocumentIdle(db,id);if((await db.query("SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('pending','queued','running','applying','checking','waiting') UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('pending','processing')",[id])).rows.length)throw Error('Traitement en cours : rapprochement périodique différé');}
export async function existingLabelProof(db,o){
 if(o.channel==='temu'){
  const j=(await db.query('SELECT status,error,packages FROM temu_label_jobs WHERE reference=$1 FOR SHARE',[o.reference])).rows[0];
  const docs=(await db.query('SELECT package,octet_length(pdf) bytes FROM temu_label_documents WHERE reference=$1 FOR SHARE',[o.reference])).rows;
  return j?.status==='complete'&&j.error===null&&Array.isArray(j.packages)&&j.packages.length>0&&j.packages.every(p=>docs.some(d=>d.package===p&&Number(d.bytes)>0));
 }
 const j=(await db.query('SELECT status,error,environment,tracking FROM carrier_jobs WHERE order_id=$1 FOR SHARE',[o.id])).rows[0];
 const docs=(await db.query('SELECT document_index,octet_length(pdf) bytes FROM carrier_documents WHERE order_id=$1 FOR SHARE',[o.id])).rows;
 return j?.status==='ready'&&j.error===null&&j.environment==='production'&&Array.isArray(j.tracking)&&j.tracking.length>0&&j.tracking.every((t,i)=>!!t&&docs.some(d=>Number(d.document_index)===i&&Number(d.bytes)>0));
}
// Only reads Erplain. Missing label provenance remains an explicit blocker.
export async function reconcilePreparationFromReads(db,api,id,{readDocuments=readErplainDocuments,readCommercial=async(provider,id)=>(await provider.request('query V3RecheckCommercialProof($id:ID!){Order(id:$id){id status external_reference tax_type total currency{label} line_items{type quantity price tax_amount discount discount_rule_amount ecotax tax_codes{id} variant{id sku} location{id}}}}',{id:String(id)})).Order,proveHistorical=historicalPreparationProof,labelProof=existingLabelProof,now=()=>Date.now()}={}){
 const provider={request:(query,...args)=>{if(!/^\s*query\b/.test(query))throw Error('Rattrapage · Écriture externe interdite');return api.request(query,...args);}};
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
 if(protectedOrder(o)||!o.resolution_pending_resume||!o.erp_live?.bc?.id||!o.erp_live?.bl?.id)return {updated:false};
 await assertRecheckIdle(db,id);
 const e=(await db.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1',[id])).rows[0];
 if(e?.status!=='complete'||e.error!==null)return {updated:false};
 const actions=(await db.query(resolutionStateSql,[id])).rows,state=currentResolutionState(actions);
 if(state.reviews.length||state.pendingReplacement||o.issue)return {updated:false};
 if(!await labelProof(db,o))return {updated:false};
 const shipment=await shipmentFingerprint(db,o);
 if(o.erp_live.labelPreparationFingerprint!==shipment)throw Error('Étiquette existante · Preuve de préparation absente ou différente : rapprochement requis, document conservé');
 let mapping;const before=digest(o);
 const lines=(await db.query('SELECT l.*,m.target_sku mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[id,o.channel])).rows;
 const bc=await readDocuments(provider,o.erp_live.bc.id),bl=bc.shipping_orders?.data?.find(b=>String(b.id)===String(o.erp_live.bl.id));
 if(bc.status!=='active'||bc.external_reference!==o.reference||!bl||!['ready_to_ship','shipped','delivered','completed'].includes(bl.status))throw Error('Préparation · Identité ou état du BC/BL existant différent');
 const frozen=usesRecordedBc(o);mapping=frozen?recordedBcFingerprint(bc):await currentMappingFingerprint(db,o);
 const bcAddress=bc.shipping_address;
 assertPreparationAddress(frozen?{address:{name:bcAddress?.label,street:bcAddress?.address_1,postal:bcAddress?.postal_code,city:bcAddress?.city,country:bcAddress?.country}}:o,bc,bl);
 if((!frozen&&skuTotals(lines.map(l=>currentMappingLine(l,o.channel)))!==skuTotals(bc.line_items))||skuTotals(bc.line_items)!==skuTotals(bl.line_items)||deliveryTotals(bc.line_items)!==deliveryTotals(bl.line_items))throw Error('Préparation · Mapping actuel, produits, lieux ou quantités BC/BL différents');
 const source=frozen?recordedBcPricing(o,bc):o.channel==='temu'?temuSellerTotals(o):o.source_payload?.erplainImported?o.erp_live.importedCommercialSource:o.erp_live.pricing;
 const commercial=await readCommercial(provider,bc.id);
 if(String(commercial?.id)!==String(bc.id)||commercial.status!=='active'||commercial.external_reference!==o.reference||!['exclusive','inclusive'].includes(commercial.tax_type)||commercial.tax_type!==source?.tax_type||skuTotals(commercial.line_items)!==skuTotals(bc.line_items)||deliveryTotals(commercial.line_items)!==deliveryTotals(bc.line_items))throw Error('Préparation · Preuve commerciale différente du BC ou de la source');
 const zero=(l,k)=>Object.hasOwn(l,k)&&(l[k]===null||typeof l[k]!=='boolean'&&String(l[k]).trim()!==''&&Number.isFinite(Number(l[k]))&&Number(l[k])===0);
 const neutral=l=>l.type==='shipping_cost'&&Number(l.quantity)===1&&['price','tax_amount','discount','discount_rule_amount','ecotax'].every(k=>zero(l,k));
 const compared=source.items?.some(l=>l.type==='shipping_cost')?commercial.line_items:commercial.line_items.filter(l=>!neutral(l));
 if(!frozen)verifyBcLineIdentity(compared,source.items);
 const confirmed=frozen?recordedBcPricing(o,commercial).confirmed:verifySourceCommercialTotals(commercial,source);let historicalStockProof=o.erp_live.historicalStockProof,stockDocument=o.erp_live.stockDocument;
 if(bc.update_stock===true){historicalStockProof=await proveHistorical(provider,{...o,items:bc.line_items,erp_live:{...o.erp_live,bc,bl}});}
 else{
  if(bc.update_stock!==false||bl.update_stock!==false||!stockDocument?.id)throw Error('Préparation · Sortie de stock existante non identifiée');
  const actual=(await provider.request('query V3RecheckExistingStock($id:ID!){StockRemoval(id:$id){id label status notes update_stock line_items{type quantity variant{id} location{id}}}}',{id:String(stockDocument.id)})).StockRemoval;
  if(String(actual?.id)!==String(stockDocument.id)||actual.label!==stockDocument.label||actual.status!=='completed'||actual.update_stock!==true||actual.notes!=='LIVE : sortie de stock liée au BL '+bl.label||deliveryTotals(actual.line_items)!==deliveryTotals(bl.line_items))throw Error('Préparation · Sortie de stock existante incompatible avec le BL');
  stockDocument={...stockDocument,...actual};
 }
 return db.transaction(async tx=>{
  const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];await assertRecheckIdle(tx,id);
  await tx.query('SELECT id FROM resolution_jobs WHERE order_id=$1 FOR SHARE',[id]);
  await tx.query('SELECT order_id FROM correction_jobs WHERE order_id=$1 FOR SHARE',[id]);
  const latest=currentResolutionState((await tx.query(resolutionStateSql,[id])).rows);
  const job=(await tx.query('SELECT status,error FROM erp_live_jobs WHERE order_id=$1 FOR SHARE',[id])).rows[0];
  if(protectedOrder(fresh)||digest(fresh)!==before||latest.reviews.length||latest.pendingReplacement||job?.status!=='complete'||job.error!==null||(!frozen&&await currentMappingFingerprint(tx,fresh)!==mapping)||await shipmentFingerprint(tx,fresh)!==shipment||!await labelProof(tx,fresh))return {updated:false,changedDuringRead:true};
  const at=new Date(now()).toISOString(),proof={...fresh.erp_live,bc,bl,phase:'bl_ready',stockDocument,historicalStockProof,mappingPreparationFingerprint:mapping,...(frozen?{preparationAuthority:{kind:'recorded_bc',bcId:String(bc.id),fingerprint:mapping}}:{}),verifiedAt:at,stockCheckedAt:at,pricing:{...fresh.erp_live.pricing,confirmed,status:'verified',error:null,commercialBasis:source.commercialBasis},periodicReconciliation:{checkedAt:at,providerMutations:0,labelsPreserved:true}};
  await tx.query("UPDATE orders SET erp_live=$2::jsonb,resolution_pending_resume=false,label_status='production_ready',simulation=false WHERE id=$1",[id,JSON.stringify(proof)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system:order-recheck','preparation.read_reconciled',$1)",[JSON.stringify({orderId:id,bcId:bc.id,blId:bl.id,mappingFingerprint:mapping,shipmentFingerprint:shipment,checkedAt:at,providerMutations:0,labelsPreserved:true})]);
  return {updated:true,labelsPreserved:true,providerMutations:0};
 });
}
