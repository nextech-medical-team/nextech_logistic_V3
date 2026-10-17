import {createHash} from 'node:crypto';
import {cancellationBlock} from './erp-transient-policy.mjs';
// No catalogue price, cost, stock or tax is invented. Missing unit weight follows
// the human 5 g rule, independently of sales channel and shipment weight.
import {DEFAULT_UNIT_WEIGHT_GRAMS,businessWeight,missingWeight} from './weight-business-policy.mjs';
import {erplainWeightInput} from './erplain-weight-input.mjs';
export const sameSku=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.trim().toLowerCase()===b.trim().toLowerCase();
const selection='id sku active weight_amount weight_unit track_inventory variant_prices{id amount} tax_codes{id} product{id label active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}';
export const creationTable=`CREATE TABLE IF NOT EXISTS erplain_product_creation_attempts(sku TEXT PRIMARY KEY,status TEXT NOT NULL,product_id TEXT,variant_id TEXT,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
export function sourceProductName(line){
 const p=line?.source_payload;if(!p||typeof p!=='object')return '';
 for(const source of [p,p.excel]){
  if(!source||typeof source!=='object'||Array.isArray(source))continue;
  const values=Object.fromEntries(Object.entries(source).map(([k,v])=>[k.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''),v]));
  for(const key of ['productname','goodsname','itemname','name','title','produits','nomproduit','nomduproduit','nomduproduitparcommandeduclient','designation','libelle']){
   if(typeof values[key]==='string'&&values[key].trim())return values[key].trim().replace(/\s+/g,' ').slice(0,250);
  }
 }
 return '';
}
export function minimalProductInput(sku,label){
 if(typeof sku!=='string'||!sku.trim()||sku.trim().length>199)throw Error('Création produit · SKU requis');
 if(typeof label!=='string'||!label.trim()||label.trim().length>250)throw Error('Création produit · Nom du produit manquant ou invalide : '+sku);
 return {label:label.trim(),active:true,variants:{data:[{type:'normal',sku:sku.trim(),track_inventory:true,weight_amount:DEFAULT_UNIT_WEIGHT_GRAMS,weight_unit:'g'}]}};
}
export async function readCreationSku(api,sku){
 const result=await api.request(`query V3MissingProductLookup($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{${selection}} paginatorInfo{hasMorePages}}}`,{where:{column:'SKU',operator:'EQ',value:sku}});
 if(!Array.isArray(result?.Variants?.data)||result.Variants.paginatorInfo?.hasMorePages!==false||result.Variants.data.length>=100)throw Error('API Erplain · Recherche produit incomplète : '+sku);
 if(result.Variants.data.some(v=>!sameSku(v?.sku,sku)))throw Error('API Erplain · Recherche produit incohérente : '+sku);
 // Preserve the provider spelling as evidence; local mappings retain their key.
 // This does not rename any supplier product or merge duplicate variants.
 return result.Variants.data.map(v=>v.sku===sku?v:{...v,erplainSku:v.sku,sku});
}
export function assertAbsentProductPrices(v){
 if(!Object.hasOwn(v,'variant_prices')||(v.variant_prices!==null&&!Array.isArray(v.variant_prices)))throw Error('Prix catalogue non vérifiables');
 if((v.variant_prices||[]).some(p=>!p||!Object.hasOwn(p,'amount')||p.amount!==null))throw Error('Prix catalogue présent dans Erplain : création sans prix non confirmée');
 return v;
}
function uniqueActive(rows,sku,productId){
 if(rows.some(v=>!sameSku(v?.sku,sku)))throw Error('API Erplain · Identité SKU différente : '+sku);
 if(rows.length!==1)throw Error('Création produit · SKU Erplain ambigu : '+sku);
 const v=rows[0];if(!v.id||!v.product?.id||v.active!==true||v.product.active!==true)throw Error('Création produit · Produit existant inactif ou incomplet : '+sku);
 if(productId&&String(v.product.id)!==String(productId))throw Error('Création produit · Identité créée différente du SKU relu : '+sku);
 return v;
}
export async function reconcileCreationAttempt(db,v){
 await db.exec(creationTable);
 const prior=(await db.query('SELECT status,product_id FROM erplain_product_creation_attempts WHERE sku=$1',[v.sku])).rows[0];
 if(prior&&prior.status!=='verified'){
  assertAbsentProductPrices(v);
  if(prior.product_id&&String(prior.product_id)!==String(v.product.id))throw Error('Création produit · Identité précédente à rapprocher : '+v.sku);
  await db.query("UPDATE erplain_product_creation_attempts SET status='verified',product_id=$2,variant_id=$3,error=null,updated_at=now() WHERE sku=$1",[v.sku,String(v.product.id),String(v.id)]);
 }
 return v;
}
export async function ensureMissingProduct(db,api,{sku,label,weightKg,guard=async()=>{},stage=async()=>{},initialRows,read=key=>readCreationSku(api,key)}){
 sku=String(sku||'').trim();
 // Always reread, including after restart or an uncertain response. Never replay a mutation.
 let rows=initialRows??await read(sku);
 if(rows.length){const variant=uniqueActive(rows,sku);await reconcileCreationAttempt(db,variant);return {variant,created:false};}
 const input=minimalProductInput(sku,label);
 if(!missingWeight(weightKg))Object.assign(input.variants.data[0],erplainWeightInput(weightKg));
 await guard();
 await db.exec(creationTable);
 const claimed=(await db.query("INSERT INTO erplain_product_creation_attempts(sku,status) VALUES($1,'attempted') ON CONFLICT DO NOTHING RETURNING sku",[sku])).rows.length;
 if(!claimed)throw Error('Création produit · Tentative précédente à vérifier : '+sku+' ; aucune nouvelle création automatique');
 let productId;
 try{
  // The committed unique claim also covers competing orders and manual corrections.
  rows=await read(sku);
  if(rows.length){const variant=uniqueActive(rows,sku);await verified(variant);return {variant,created:false};}
  await guard();await stage('Création du produit dans Erplain LIVE · prix absents');
  const made=await api.request('mutation V3MissingProductCreate($input:ProductInput!){CreateProduct(input:$input){id}}',{input});
  productId=made?.CreateProduct?.id;if(!productId)throw Error('Création non confirmée');
  await db.query("UPDATE erplain_product_creation_attempts SET product_id=$2,updated_at=now() WHERE sku=$1",[sku,String(productId)]);
  await stage('Relecture du produit créé dans Erplain LIVE');
  const variant=assertAbsentProductPrices(uniqueActive(await read(sku),sku,productId));
  const expected=input.variants.data[0];
  if(missingWeight(variant.weight_amount)||Math.abs(businessWeight(variant.weight_amount,variant.weight_unit).weightKg-businessWeight(expected.weight_amount,expected.weight_unit).weightKg)>1e-9)throw Error('Poids du produit créé non confirmé');
  await verified(variant);
  return {variant,created:true};
 }catch(e){
  await db.query("UPDATE erplain_product_creation_attempts SET status='review',error=$2,updated_at=now() WHERE sku=$1",[sku,String(e.message).slice(0,1000)]);
  throw Error('Création produit · Résultat à vérifier pour '+sku+' : '+e.message+' ; aucune nouvelle création automatique');
 }
 async function verified(v){await db.query("UPDATE erplain_product_creation_attempts SET status='verified',product_id=$2,variant_id=$3,error=null,updated_at=now() WHERE sku=$1",[sku,String(v.product.id),String(v.id)]);}
}

// Handles orders stopped before the BC lookup (for example a missing catalogue weight).
// Existing business holds and busy orders are explicitly excluded; only the product is written.
export function productCreationBlock(o,{resolution=false}={}){
 const p=o?.source_payload||{},e=o?.erp_live||{},t=p.temuOrderDetail?.parentOrderMap||{};
 return !o||cancellationBlock(o)||o.archived||o.partial_mode||p.erplainImported||p.marketplacePendingCorrection||p.visibilityHold||p.selectedReimport?.mode==='hold'||(p.erplainValidationHold&&p.erplainValidation!=='approved')||(!resolution&&o.resolution_pending_resume)||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled'||['cancelled','closed','completed'].includes(e.bc?.status)||['cancelled','closed','completed','shipped','delivered'].includes(e.bl?.status)||['creating_bc','creating_stock','publishing_bl','creating_bl'].includes(e.phase);
}
// A saved pricing resolution may stop on a missing SKU. Catalogue creation is
// independent of preparation; the persisted hold is never cleared here.
export async function catalogueCreationProtection(db,o,sku,blocked){
 const manual=o?.source_payload?.temuManualPricing;
 let catalogueOnly=false;
 if(o?.resolution_pending_resume&&o.channel==='temu'&&manual?.source==='manual_user'&&typeof manual.jobId==='string'&&manual.data?.parentOrderMap?.parentOrderSn===o.reference){
  const rows=(await db.query("SELECT action,status,error,result FROM resolution_jobs WHERE order_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM resolution_jobs newer WHERE newer.order_id=$1 AND newer.id<>$2 AND newer.created_at>=(SELECT created_at FROM resolution_jobs WHERE id=$2) AND newer.action<>'refresh')",[o.id,manual.jobId])).rows;
  const j=rows[0];
  catalogueOnly=rows.length===1&&j.action==='manual-temu-pricing'&&j.status==='review'&&j.result?.manualPricing===true&&j.result?.erpOnly===true&&[sku+' : SKU Erplain introuvable','BC · SKU Erplain LIVE introuvable : '+sku].includes(j.error);
 }
 const guarded=catalogueOnly?{...o,resolution_pending_resume:false}:o;
 return blocked(guarded)||productCreationBlock(guarded);
}
// A rotating review ledger prevents one incomplete historical order from starving
// all later orders. This ledger never changes business holds or job statuses.
export const backfillTable=`CREATE TABLE IF NOT EXISTS erplain_product_creation_reviews(order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,line_id TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(order_id,line_id,sku)); ALTER TABLE erplain_product_creation_reviews ADD COLUMN IF NOT EXISTS fingerprint TEXT; ALTER TABLE erplain_product_creation_reviews ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ; ALTER TABLE erplain_product_creation_reviews ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`;
const backfillInitializations=new WeakMap();
const backfillCursors=new WeakMap();
export async function initializeCatalogueReviews(db){
 if(!backfillInitializations.has(db))backfillInitializations.set(db,Promise.resolve().then(()=>db.exec(backfillTable)).catch(e=>{backfillInitializations.delete(db);throw e;}));
 await backfillInitializations.get(db);
}
export const backfillSelection=`SELECT DISTINCT o.*,e.error AS creation_job_error,r.last_checked FROM orders o
 JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku
 LEFT JOIN catalog_results c ON c.sku=CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN o.channel IN ('tender','samples') THEN l.source_sku END) END
 LEFT JOIN erp_live_jobs e ON e.order_id=o.id
 LEFT JOIN LATERAL(SELECT max(updated_at) last_checked FROM erplain_product_creation_reviews WHERE order_id=o.id) r ON true
 WHERE ((c.message LIKE '%SKU Erplain introuvable%' OR c.message='Produit introuvable dans Erplain') OR position('Création produit · Nom de la référence convertie à confirmer :' IN coalesce(e.error,''))>0 OR position('SKU Erplain LIVE introuvable :' IN coalesce(e.error,''))>0 OR position('SKU Erplain LIVE introuvable :' IN coalesce(o.issue,''))>0)
 AND o.archived=false
 AND coalesce(o.tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated') AND coalesce(o.label_status,'')<>'cancelled'
 AND coalesce(o.suspension->>'active','false')<>'true' AND NOT (coalesce(o.suspension,'{}') ? 'erplainCancellation')
 AND coalesce(o.erp_live->'bc'->>'status','') NOT IN ('cancelled','closed','completed') AND coalesce(o.erp_live->'bl'->>'status','') NOT IN ('cancelled','closed','completed','shipped','delivered')
 AND coalesce(e.status,'')<>'complete'
 AND NOT EXISTS(SELECT 1 FROM correction_jobs x WHERE x.order_id=o.id AND x.status IN ('queued','applying','checking','waiting'))
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs x WHERE x.order_id=o.id AND x.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM erp_live_jobs x WHERE x.order_id=o.id AND x.status='processing')
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs x WHERE x.order_id=o.id AND x.status IN ('pending','creating','awaiting_pdf','ready'))
 ORDER BY r.last_checked NULLS FIRST,o.received_at,o.id LIMIT 20`;
const lineSelection='SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1';
export const targetSku=(o,l)=>l.source_payload?.mappingScope==='order'?l.target_sku:l.mapped_sku||l.target_sku||(['tender','samples'].includes(o.channel)?l.source_sku:null);
export function historicalMissing(message,sku){return String(message||'').split(/\s;\s/).some(part=>part===`BC · SKU Erplain LIVE introuvable : ${sku}`||part===`Création produit · Nom de la référence convertie à confirmer : ${sku}`);}
export function missingCatalogueMessage(message){return String(message||'').includes('SKU Erplain introuvable')||message==='Produit introuvable dans Erplain';}
function lineIdentity(o,l){return JSON.stringify([o.channel,o.erp_live?.bc,o.erp_live?.bl,l.id,l.source_sku,l.target_sku,l.target_quantity,targetSku(o,l),l.mapped_sku,l.source_qty,l.target_qty,l.quantity,l.source_payload]);}
export function catalogueFingerprint(o,l,diagnostic,linked){return createHash('sha256').update(JSON.stringify([lineIdentity(o,l),sourceProductName(l),diagnostic,o.creation_job_error,o.issue,o.suspension,o.resolution_pending_resume,linked?.live_variant_id])).digest('hex');}
export function catalogueRetryAt(error,attempts,now=Date.now()){
 const transient=/Erplain HTTP (429|502|503|504)|fetch failed|Timeout|ECONNRESET|ETIMEDOUT/i.test(error||'');
 const seconds=transient?Math.max(60,Number(error?.retryAfter)||0):900;
 return new Date(now+Math.min(3600,seconds*2**Math.min(3,Math.max(0,attempts-1)))*1000).toISOString();
}
export async function createBlockedMissingProducts(db,api,{blocked,bind,now=()=>Date.now()}){
 await initializeCatalogueReviews(db);
 // Rotate past sleeping reviews too: the first twenty must not hide a later
 // order whose mapping/name was corrected while its previous retry is pending.
 const cursor=backfillCursors.get(db)||'';
 const orders=(await db.query(backfillSelection.replace('ORDER BY r.last_checked NULLS FIRST,o.received_at,o.id LIMIT 20','AND o.id>$1 ORDER BY o.id LIMIT 20'),[cursor])).rows;
 if(!orders.length){backfillCursors.delete(db);return [];}
 let handled=0;
 const report=[],lookups=new Map();
 for(const o of orders){
  backfillCursors.set(db,o.id);
  if(cancellationBlock(o)||productCreationBlock(o)&&!o.resolution_pending_resume)continue;
  const lines=(await db.query(lineSelection,[o.id,o.channel])).rows;
  for(const line of lines){
   const sku=targetSku(o,line);if(!sku)continue;
   const diagnostic=(await db.query('SELECT message FROM catalog_results WHERE sku=$1',[sku])).rows[0]?.message;
   if(!missingCatalogueMessage(diagnostic)&&!historicalMissing(o.creation_job_error,sku)&&!historicalMissing(o.issue,sku))continue;
   const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[sku])).rows[0];
   const fingerprint=catalogueFingerprint(o,line,diagnostic,linked);
   const previous=(await db.query('SELECT fingerprint,next_check_at,attempts FROM erplain_product_creation_reviews WHERE order_id=$1 AND line_id=$2 AND sku=$3',[o.id,String(line.id),sku])).rows[0];
   if(previous?.fingerprint===fingerprint&&Date.parse(previous.next_check_at)>now())continue;
   const attempts=previous?.fingerprint===fingerprint?Number(previous.attempts||0)+1:1;
   let status='review',error=null,variantId=null,retryAfter=0;
   try{
    const freshBefore=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
    const protection=await catalogueCreationProtection(db,freshBefore,sku,blocked);
    if(protection)throw Error('Commande protégée : création suspendue');
    if(lineIdentity(freshBefore,line)!==lineIdentity(o,line))throw Error('Commande modifiée : création suspendue');
    await api.verify();
    const read=async key=>{
     const freshRead=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
     if(await catalogueCreationProtection(db,freshRead,sku,blocked))throw Error('Commande protégée : création suspendue');
     const lookupKey=key.toLowerCase();
     let pending=lookups.get(lookupKey);if(!pending){pending=readCreationSku(api,key);lookups.set(lookupKey,pending);}
     const rows=await pending;
     if(linked&&(!rows.length||rows.length!==1||String(rows[0].id)!==String(linked.live_variant_id)))throw Error('Création produit · Référence liée à rapprocher : '+sku);
     return rows;
    };
    const existing=await read(sku);
    const result=await ensureMissingProduct(db,api,{sku,label:sourceProductName(line),initialRows:existing,read:async key=>{lookups.delete(key.toLowerCase());return read(key);},guard:async()=>{
     const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
     if(await catalogueCreationProtection(db,fresh,sku,blocked))throw Error('Commande protégée : création suspendue');
     const current=(await db.query(lineSelection,[o.id,o.channel])).rows.find(l=>l.id===line.id);
     if(!current||lineIdentity(fresh,current)!==lineIdentity(o,line))throw Error('Correspondance ou ligne modifiée : création suspendue');
     const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready')",[o.id])).rows.length;
     if(busy)throw Error('Traitement en cours : création suspendue');
    }});
    // Recheck protections after a possibly long supplier call and before cache binding.
    const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
    const current=(await db.query(lineSelection,[o.id,o.channel])).rows.find(l=>l.id===line.id);
    if(await catalogueCreationProtection(db,fresh,sku,blocked)||!current||lineIdentity(fresh,current)!==lineIdentity(o,line))throw Error('Commande ou correspondance modifiée : liaison suspendue');
    const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready')",[o.id])).rows.length;
    if(busy)throw Error('Traitement en cours : liaison suspendue');
    const binding=await bind({...result.variant,sku});
    const {refreshLookupDiagnostics}=await import('./catalogue-lookup-diagnostics.mjs');
    await refreshLookupDiagnostics(db,fresh,{sku,status:'active',complete:true,sourceReadOnly:true,readAt:new Date().toISOString(),variantId:String(result.variant.id),productId:String(result.variant.product.id),documentId:fresh.erp_live?.bc?.id??null});
    variantId=String(result.variant.id);status=result.created?'created':'existing';error=binding?.message||null;
   }catch(e){error=String(e.message).slice(0,1000);retryAfter=Number(e.retryAfter)||0;}
   await db.query(`INSERT INTO erplain_product_creation_reviews(order_id,line_id,sku,status,error,fingerprint,next_check_at,attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(order_id,line_id,sku) DO UPDATE SET status=excluded.status,error=excluded.error,fingerprint=excluded.fingerprint,next_check_at=excluded.next_check_at,attempts=excluded.attempts,updated_at=now()`,[o.id,String(line.id),sku,status,error,fingerprint,new Date(Math.max(Date.parse(catalogueRetryAt(error,attempts,now())),now()+retryAfter*1000)).toISOString(),attempts]);
   report.push({orderId:o.id,lineId:line.id,sku,status,error,variantId});
   // Never run recheckOrders here: that broad continuation can regenerate labels.
   // Only the exact stale missing-SKU error is reconciled by the guarded helper.
   if(++handled>=3||retryAfter>0||/Erplain HTTP 429/.test(error||''))return report;
  }
 }
 return report;
}
