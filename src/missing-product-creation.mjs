// No catalogue price, cost, stock, weight or tax is invented by this operation.
const selection='id sku active weight_amount weight_unit track_inventory variant_prices{id amount} tax_codes{id} product{id label active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}';
export const creationTable=`CREATE TABLE IF NOT EXISTS erplain_product_creation_attempts(sku TEXT PRIMARY KEY,status TEXT NOT NULL,product_id TEXT,variant_id TEXT,error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
export function sourceProductName(line){
 const p=line?.source_payload;if(!p||typeof p!=='object')return '';
 const values=Object.fromEntries(Object.entries(p).map(([k,v])=>[k.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''),v]));
 for(const key of ['productname','goodsname','itemname','name','title','produits','nomproduit','designation','libelle']){
  if(typeof values[key]==='string'&&values[key].trim())return values[key].trim().replace(/\s+/g,' ').slice(0,250);
 }
 return '';
}
export function minimalProductInput(sku,label){
 if(typeof sku!=='string'||!sku.trim()||sku.trim().length>199)throw Error('Création produit · SKU requis');
 if(typeof label!=='string'||!label.trim()||label.trim().length>250)throw Error('Création produit · Nom du produit manquant ou invalide : '+sku);
 return {label:label.trim(),active:true,variants:{data:[{type:'normal',sku:sku.trim(),track_inventory:true}]}};
}
export async function readCreationSku(api,sku){
 const result=await api.request(`query V3MissingProductLookup($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{${selection}} paginatorInfo{hasMorePages}}}`,{where:{column:'SKU',operator:'EQ',value:sku}});
 if(!Array.isArray(result?.Variants?.data)||result.Variants.paginatorInfo?.hasMorePages!==false||result.Variants.data.length>=100)throw Error('API Erplain · Recherche produit incomplète : '+sku);
 if(result.Variants.data.some(v=>v?.sku!==sku))throw Error('API Erplain · Recherche produit incohérente : '+sku);
 return result.Variants.data;
}
export function assertAbsentProductPrices(v){
 if(!Object.hasOwn(v,'variant_prices')||(v.variant_prices!==null&&!Array.isArray(v.variant_prices)))throw Error('Prix catalogue non vérifiables');
 if((v.variant_prices||[]).some(p=>!p||!Object.hasOwn(p,'amount')||p.amount!==null))throw Error('Prix catalogue présent dans Erplain : création sans prix non confirmée');
 return v;
}
function uniqueActive(rows,sku,productId){
 if(rows.some(v=>v?.sku!==sku))throw Error('API Erplain · Identité SKU différente : '+sku);
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
export async function ensureMissingProduct(db,api,{sku,label,weightKg,guard=async()=>{},stage=async()=>{},read=key=>readCreationSku(api,key)}){
 sku=String(sku||'').trim();
 // Always reread, including after restart or an uncertain response. Never replay a mutation.
 let rows=await read(sku);
 if(rows.length){const variant=uniqueActive(rows,sku);await reconcileCreationAttempt(db,variant);return {variant,created:false};}
 const input=minimalProductInput(sku,label);
 if(weightKg!==undefined){if(!Number.isFinite(Number(weightKg))||Number(weightKg)<=0||Number(weightKg)>3000)throw Error('Poids invalide');Object.assign(input.variants.data[0],{weight_amount:Number(weightKg),weight_unit:'kg'});}
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
  const variant=assertAbsentProductPrices(uniqueActive(await read(sku),sku,productId));await verified(variant);
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
 return !o||o.archived||o.partial_mode||p.erplainImported||p.marketplacePendingCorrection||p.visibilityHold||p.selectedReimport?.mode==='hold'||(p.erplainValidationHold&&p.erplainValidation!=='approved')||(!resolution&&o.resolution_pending_resume)||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled'||['cancelled','closed','completed'].includes(e.bc?.status)||['cancelled','closed','completed','shipped','delivered'].includes(e.bl?.status)||['creating_bc','creating_stock','publishing_bl','creating_bl'].includes(e.phase);
}
// A rotating review ledger prevents one incomplete historical order from starving
// all later orders. This ledger never changes business holds or job statuses.
export const backfillTable=`CREATE TABLE IF NOT EXISTS erplain_product_creation_reviews(order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,line_id TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(order_id,line_id,sku))`;
export const backfillSelection=`SELECT DISTINCT o.*,e.error AS creation_job_error,r.last_checked FROM orders o
 JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku
 LEFT JOIN catalog_results c ON c.sku=CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN o.channel IN ('tender','samples') THEN l.source_sku END) END
 LEFT JOIN erp_live_jobs e ON e.order_id=o.id
 LEFT JOIN LATERAL(SELECT max(updated_at) last_checked FROM erplain_product_creation_reviews WHERE order_id=o.id) r ON true
 WHERE ((c.message LIKE '%SKU Erplain introuvable%' OR c.message='Produit introuvable dans Erplain') OR position('Création produit · Nom de la référence convertie à confirmer :' IN coalesce(e.error,''))>0 OR position('SKU Erplain LIVE introuvable :' IN coalesce(e.error,''))>0 OR position('SKU Erplain LIVE introuvable :' IN coalesce(o.issue,''))>0)
 AND o.archived=false
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs x WHERE x.order_id=o.id AND x.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM erp_live_jobs x WHERE x.order_id=o.id AND x.status='processing')
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs x WHERE x.order_id=o.id AND x.status IN ('pending','creating','awaiting_pdf','ready'))
 ORDER BY r.last_checked NULLS FIRST,o.received_at,o.id LIMIT 20`;
const lineSelection='SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1';
export const targetSku=(o,l)=>l.source_payload?.mappingScope==='order'?l.target_sku:l.mapped_sku||l.target_sku||(['tender','samples'].includes(o.channel)?l.source_sku:null);
export function historicalMissing(message,sku){return String(message||'').split(/\s;\s/).some(part=>part===`BC · SKU Erplain LIVE introuvable : ${sku}`||part===`Création produit · Nom de la référence convertie à confirmer : ${sku}`);}
export function missingCatalogueMessage(message){return String(message||'').includes('SKU Erplain introuvable')||message==='Produit introuvable dans Erplain';}
function lineIdentity(o,l){return JSON.stringify([o.channel,o.erp_live?.bc,o.erp_live?.bl,l.id,l.source_sku,l.target_sku,l.target_quantity,targetSku(o,l),l.mapped_sku,l.source_qty,l.target_qty,l.quantity,l.source_payload]);}
export async function createBlockedMissingProducts(db,api,{blocked,bind}){
 await db.exec(backfillTable);
 const orders=(await db.query(backfillSelection)).rows;
 let handled=0;
 const report=[];
 for(const o of orders){
  const lines=(await db.query(lineSelection,[o.id,o.channel])).rows;
  for(const line of lines){
   const sku=targetSku(o,line);if(!sku)continue;
   const diagnostic=(await db.query('SELECT message FROM catalog_results WHERE sku=$1',[sku])).rows[0]?.message;
   if(!missingCatalogueMessage(diagnostic)&&!historicalMissing(o.creation_job_error,sku)&&!historicalMissing(o.issue,sku))continue;
   let status='review',error=null,variantId=null;
   try{
    const protection=blocked(o)||productCreationBlock(o);
    const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[sku])).rows[0];
    await api.verify();
    const read=async key=>{
     const rows=await readCreationSku(api,key);
     if(linked&&(!rows.length||rows.length!==1||String(rows[0].id)!==String(linked.live_variant_id)))throw Error('Création produit · Référence liée à rapprocher : '+sku);
     return rows;
    };
    const existing=await read(sku);
    if(protection){
     if(!existing.length)throw Error('Commande protégée : création suspendue');
     const v=uniqueActive(existing,sku);
     const {refreshLookupDiagnostics}=await import('./catalogue-lookup-diagnostics.mjs');
     await refreshLookupDiagnostics(db,o,{sku,status:'active',complete:true,sourceReadOnly:true,readAt:new Date().toISOString(),variantId:String(v.id),productId:String(v.product.id),documentId:o.erp_live?.bc?.id??null});
     variantId=String(v.id);status='existing';
    }else{
    const result=await ensureMissingProduct(db,api,{sku,label:sourceProductName(line),read,guard:async()=>{
     const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
     if(blocked(fresh)||productCreationBlock(fresh))throw Error('Commande protégée : création suspendue');
     const current=(await db.query(lineSelection,[o.id,o.channel])).rows.find(l=>l.id===line.id);
     if(!current||lineIdentity(fresh,current)!==lineIdentity(o,line))throw Error('Correspondance ou ligne modifiée : création suspendue');
     const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready')",[o.id])).rows.length;
     if(busy)throw Error('Traitement en cours : création suspendue');
    }});
    // Recheck protections after a possibly long supplier call and before cache binding.
    const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
    const current=(await db.query(lineSelection,[o.id,o.channel])).rows.find(l=>l.id===line.id);
    if(blocked(fresh)||productCreationBlock(fresh)||!current||lineIdentity(fresh,current)!==lineIdentity(o,line))throw Error('Commande ou correspondance modifiée : liaison suspendue');
    const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready')",[o.id])).rows.length;
    if(busy)throw Error('Traitement en cours : liaison suspendue');
    const binding=await bind(result.variant);
    const {refreshLookupDiagnostics}=await import('./catalogue-lookup-diagnostics.mjs');
    await refreshLookupDiagnostics(db,fresh,{sku,status:'active',complete:true,sourceReadOnly:true,readAt:new Date().toISOString(),variantId:String(result.variant.id),productId:String(result.variant.product.id),documentId:fresh.erp_live?.bc?.id??null});
    variantId=String(result.variant.id);status=result.created?'created':'existing';error=binding?.message||null;
    }
   }catch(e){error=String(e.message).slice(0,1000);}
   await db.query(`INSERT INTO erplain_product_creation_reviews(order_id,line_id,sku,status,error) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,line_id,sku) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=now()`,[o.id,String(line.id),sku,status,error]);
   report.push({orderId:o.id,lineId:line.id,sku,status,error,variantId});
   // Never run recheckOrders here: that broad continuation can regenerate labels.
   // Only the exact stale missing-SKU error is reconciled by the guarded helper.
   if(++handled>=3)return report;
  }
 }
 return report;
}
