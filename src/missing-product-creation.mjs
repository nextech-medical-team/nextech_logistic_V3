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
 return result.Variants.data.filter(v=>v.sku===sku);
}
export function assertAbsentProductPrices(v){
 if(!Object.hasOwn(v,'variant_prices')||(v.variant_prices!==null&&!Array.isArray(v.variant_prices)))throw Error('Prix catalogue non vérifiables');
 if((v.variant_prices||[]).some(p=>!p||!Object.hasOwn(p,'amount')||p.amount!==null))throw Error('Prix catalogue présent dans Erplain : création sans prix non confirmée');
 return v;
}
function uniqueActive(rows,sku,productId){
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
export async function createBlockedMissingProducts(db,api,{blocked,bind,recheck}){
 const orders=(await db.query(`SELECT DISTINCT o.* FROM orders o JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku JOIN catalog_results c ON c.sku=coalesce(l.target_sku,m.target_sku,CASE WHEN o.channel IN ('tender','samples') THEN l.source_sku END)
 WHERE coalesce(o.issue,'') NOT LIKE 'Création produit ·%' AND coalesce(o.source_payload->'selectedReimport'->>'mode','')<>'hold' AND NOT (o.source_payload ? 'marketplacePendingCorrection') AND c.message LIKE '%SKU Erplain introuvable%' AND o.archived=false AND o.resolution_pending_resume=false
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='processing')
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs j WHERE j.order_id=o.id AND j.status IN ('pending','creating','awaiting_pdf','ready'))
 ORDER BY o.received_at,o.id LIMIT 20`)).rows;
 let handled=0;
 for(const o of orders){
  if(blocked(o)||productCreationBlock(o))continue;
  const lines=(await db.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1',[o.id,o.channel])).rows;
  let touched=false,problem=null;
  for(const line of lines){
   const sku=line.target_sku||line.mapped_sku||(['tender','samples'].includes(o.channel)?line.source_sku:null);if(!sku)continue;
   const diagnostic=(await db.query('SELECT message FROM catalog_results WHERE sku=$1',[sku])).rows[0]?.message;
   if(!diagnostic?.includes('SKU Erplain introuvable'))continue;
   try{
    const linked=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1',[sku])).rows[0];
    if(linked)throw Error('Création produit · Référence liée à vérifier : '+sku);
    await api.verify();
    if(line.source_qty&&Number(line.source_qty)!==Number(line.target_qty))throw Error('Création produit · Nom de la référence convertie à confirmer : '+sku);
    const result=await ensureMissingProduct(db,api,{sku,label:sourceProductName(line),guard:async()=>{
     const fresh=(await db.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
     if(blocked(fresh)||productCreationBlock(fresh))throw Error('Commande protégée : création suspendue');
     const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','ready')",[o.id])).rows.length;
     if(busy)throw Error('Traitement en cours : création suspendue');
    }});
    const binding=await bind(result.variant);touched=true;
    if(binding?.message)problem=binding.message;
   }catch(e){problem=e.message;}
   if(++handled>=3)break;
  }
  if(touched&&!problem){const checks=await recheck([o.id]);problem=checks.find(c=>c.id===o.id)?.problem||problem;}
  if(problem){await db.query("UPDATE orders SET issue=$2 WHERE id=$1",[o.id,problem]);await db.query("UPDATE erp_live_jobs SET error=$2,updated_at=now() WHERE order_id=$1 AND status='review'",[o.id,problem]);}
  if(handled>=3)return;
 }
}
