import {ensureMissingProduct,readCreationSku,backfillTable,productCreationBlock} from './missing-product-creation.mjs';
import {partialTemuReadProof,pureTemuSourceReadError} from './temu-catchup-policy.mjs';
import {withinReceptionStart} from './order-visibility.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
export const incompleteCatalogueSelection=`SELECT o.*,q.observation AS catalogue_observation,r.last_checked FROM orders o
 JOIN temu_source_catchup q ON q.order_id=o.id LEFT JOIN LATERAL(SELECT max(updated_at) last_checked FROM erplain_product_creation_reviews WHERE order_id=o.id AND line_id LIKE 'temu-source:%') r ON true
 WHERE o.channel='temu' AND NOT o.archived AND o.duplicate_of IS NULL AND o.source_payload->>'visibilityHold'='true'
 AND q.observation->>'sourceStage' IN ('pending','fulfillment','cancelled') AND NOT EXISTS(SELECT 1 FROM lines WHERE order_id=o.id)
 AND (r.last_checked IS NULL OR r.last_checked<now()-interval '15 minutes' OR q.updated_at>r.last_checked) ORDER BY r.last_checked NULLS FIRST,q.last_attempt_at DESC,o.id LIMIT 20`;
export function sourceCatalogueBlock(order,observation,settings,now=Date.now()){
 if(!order||order.channel!=='temu'||order.duplicate_of||!observation)return 'Catalogue: source absente';
 const proof=partialTemuReadProof(order,observation),p=order?.source_payload||{},e=order?.erp_live||{};
 if(!proof||!Number.isFinite(Date.parse(proof.checkedAt))||Date.parse(proof.checkedAt)>now||now-Date.parse(proof.checkedAt)>15*60000||!['pending','fulfillment','cancelled'].includes(proof.sourceStage))return 'Catalogue · Détail source stable et récent requis';
 // Platform declarations never veto the catalogue needed for the first BC.
 // Positive source quantities, local cancellations and uncertain writes remain
 // independently checked; this does not import or reactivate an order.
 if(p.visibilityHold!==true||p.marketplacePendingCorrection||p.temuDirect?.attemptedAt||p.externalLabel||e.phase||e.customer?.id||e.bc?.id||e.bl?.id||e.stockDocument?.id||e.stockCreationAttemptedAt||order.suspension?.active||Object.hasOwn(order.suspension||{},'erplainCancellation'))return 'Catalogue · Commande protégée';
 const sourceOnly=!order.issue||pureTemuSourceReadError(order.issue)||order.issue===p.temuCatchupPartial?.currentReason||order.issue==='TEMU · Import incomplet : coordonnées ou détail indisponibles, reprise après nouvelle lecture TEMU'||order.issue==='TEMU · Coordonnées de livraison absentes · Lecture automatique planifiée';
 if(!sourceOnly)return 'Catalogue · Blocage indépendant à conserver';
 // This exception applies only to creating a catalogue record. No order flag is changed.
 if(productCreationBlock({...order,resolution_pending_resume:false,source_payload:{...p,visibilityHold:false}}))return 'Catalogue · Commande protégée';
 if(settings.automatic_live?.enabled!==true||settings.marketplace_automatic?.enabled!==true||settings.marketplace_automatic.channels?.temu===false)return 'Catalogue · Préparation automatique suspendue';
 try{if(!withinReceptionStart('temu',observation.payload,settings.marketplace_automatic))return 'Catalogue · Réception antérieure au début autorisé';}catch{return 'Catalogue · Date source non vérifiable';}
 return null;
}
const identity=(o,obs)=>JSON.stringify([o.id,o.channel,o.duplicate_of,o.reference,o.source_reference,o.archived,o.partial_mode,o.suspension,o.resolution_pending_resume,o.label_status,o.tracking_status,o.source_payload,o.erp_live,o.issue,obs]);
export async function prepareIncompleteTemuCatalogue(db,api,{bind,now=()=>Date.now(),withLock=withShipmentLock}={}){
 if(!(await db.query("SELECT to_regclass('public.temu_source_catchup') AS present")).rows[0]?.present)return {skipped:true};
 await db.exec(backfillTable);const settings=Object.fromEntries((await db.query("SELECT key,value FROM settings WHERE key IN ('automatic_live','marketplace_automatic')")).rows.map(r=>[r.key,r.value]));
 if(settings.automatic_live?.enabled!==true||settings.marketplace_automatic?.enabled!==true||settings.marketplace_automatic.channels?.temu===false)return {skipped:true};
 const orders=(await db.query(incompleteCatalogueSelection)).rows,report=[];
 for(const order of orders){const reportStart=report.length,observation=order.catalogue_observation;for(const line of observation?.payload?.detail?.orderList||[]){
  if(!(Number(line.quantity)>0))continue;const codes=[...new Set((line.productList||[]).map(p=>p.extCode).filter(Boolean))],sourceSku=codes.length===1?codes[0]:null;
  let sku=sourceSku||'[source-ambiguous]',status='review',error=null,variantId=null;
  try{await withLock(async()=>{
   const protection=sourceCatalogueBlock(order,observation,settings,now());if(protection)throw Error(protection);if(!sourceSku)throw Error('Catalogue · SKU source absent ou ambigu');
   const maps=(await db.query("SELECT target_sku,source_qty,target_qty FROM mappings WHERE channel='temu' AND source_sku=$1",[sourceSku])).rows;
   if(maps.length!==1||!maps[0].target_sku)throw Error('Catalogue · Conversion SKU à confirmer');const mapping=maps[0];sku=mapping.target_sku;
   const guard=async()=>{
    const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[order.id])).rows[0],obs=(await db.query('SELECT observation FROM temu_source_catchup WHERE order_id=$1',[order.id])).rows[0]?.observation;
    const controls=Object.fromEntries((await db.query("SELECT key,value FROM settings WHERE key IN ('automatic_live','marketplace_automatic')")).rows.map(r=>[r.key,r.value]));
    if(!fresh||identity(fresh,obs)!==identity(order,observation)||sourceCatalogueBlock(fresh,obs,controls,now()))throw Error('Catalogue · Source, commande ou autorisation modifiée');
    const current=(await db.query("SELECT target_sku,source_qty,target_qty FROM mappings WHERE channel='temu' AND source_sku=$1",[sourceSku])).rows;if(current.length!==1||JSON.stringify(current[0])!==JSON.stringify(mapping))throw Error('Catalogue · Conversion modifiée');
    const protectedHistory=(await db.query(`SELECT EXISTS(SELECT 1 FROM lines WHERE order_id=$1) OR EXISTS(SELECT 1 FROM resolution_jobs WHERE order_id=$1) OR EXISTS(SELECT 1 FROM correction_jobs WHERE order_id=$1) OR EXISTS(SELECT 1 FROM carrier_documents WHERE order_id=$1) OR EXISTS(SELECT 1 FROM carrier_jobs WHERE order_id=$1) OR EXISTS(SELECT 1 FROM partial_deliveries WHERE order_id=$1) OR EXISTS(SELECT 1 FROM extra_parcels WHERE order_id=$1) OR EXISTS(SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status NOT IN ('review','failed')) OR EXISTS(SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0)) AS protected`,[order.id,order.reference])).rows[0];
    if(!protectedHistory||protectedHistory.protected)throw Error('Catalogue · Historique ou traitement protégé');
   };
   await guard();await api.verify();
   const label=typeof line.originalGoodsName==='string'&&line.originalGoodsName.trim()?line.originalGoodsName.trim():typeof line.goodsName==='string'?line.goodsName.trim():'';
   const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[sku])).rows[0];
   const read=async key=>{const rows=await readCreationSku(api,key);if(linked&&(rows.length!==1||String(rows[0].id)!==String(linked.live_variant_id)))throw Error('Catalogue: identite liee a rapprocher');return rows;};
   const result=await ensureMissingProduct(db,api,{sku,label,read,guard:async()=>{await guard();
    // A pack-to-unit ratio does not change the identity or source product name.
    // A different target SKU still needs its own authoritative catalogue name.
    if(sku!==sourceSku)throw Error('Catalogue · Nom de la référence convertie à confirmer : '+sku);
    if(![mapping.source_qty,mapping.target_qty].every(v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>0))throw Error('Catalogue · Conversion de quantité invalide : '+sku);
   }});
   await guard();if(bind)await bind(result.variant);variantId=String(result.variant.id);status=result.created?'created':'existing';
   await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system:temu-source-catalogue','temu.source.catalogue_prepared',$1::jsonb)",[JSON.stringify({orderId:order.id,sku,variantId,created:result.created,financialHoldUnchanged:true,orderWrites:0,stockWrites:0,labelWrites:0})]);
  });}catch(e){error=String(e.message).slice(0,700);}
  await db.query(`INSERT INTO erplain_product_creation_reviews(order_id,line_id,sku,status,error) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,line_id,sku) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=now()`,[order.id,'temu-source:'+String(line.orderSn),sku,status,error]);report.push({orderId:order.id,sku,status,error,variantId});
 }if(report.length===reportStart){const error='Catalogue: articles source actifs absents, verification requise';await db.query("INSERT INTO erplain_product_creation_reviews(order_id,line_id,sku,status,error) VALUES($1,'temu-source:__observation__','','review',$2) ON CONFLICT(order_id,line_id,sku) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=now()",[order.id,error]);report.push({orderId:order.id,sku:null,status:'review',error});}}return {report};
}
