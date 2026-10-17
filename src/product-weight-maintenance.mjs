import {erplainAccount} from './erplain-accounts.mjs';
import {fillMissingVariantWeight,missingWeight,businessWeight} from './weight-business-policy.mjs';
import {cacheProviderWeight} from './product-weight-cache.mjs';
import {reconcileVerifiedWeights} from './verified-weight-diagnostics.mjs';

export async function initializeProductWeightMaintenance(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS erplain_weight_checks(sku TEXT PRIMARY KEY,checked_at TIMESTAMPTZ,error TEXT);
 CREATE TABLE IF NOT EXISTS erplain_weight_repairs(variant_id TEXT PRIMARY KEY,sku TEXT NOT NULL,product_id TEXT NOT NULL,state TEXT NOT NULL,before_value JSONB,after_value JSONB,error TEXT,attempted_at TIMESTAMPTZ,history JSONB NOT NULL DEFAULT '[]',updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
}
const lookup=`query V3MaintainWeight($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku active weight_amount weight_unit product{id active}} paginatorInfo{hasMorePages}}}`;
const readVariant=`query V3MaintainWeightRead($id:ID!){Variant(id:$id){id sku active weight_amount weight_unit product{id active}}}`;
export function productWeightMaintenance(db,directory,{api=erplainAccount(directory,'live'),enabled=()=>false,batchSize=10,now=Date.now,cache=cacheProviderWeight,reconcile=reconcileVerifiedWeights}={}){
 let running=false;
 const guarded=async(query,variables)=>{if(!enabled())throw Error('Maintenance des poids suspendue');return api.request(query,variables);};
 async function maintain(v){
  return db.withLocks(['product-weight:'+v.id],async()=>{
   if(!enabled())throw Error('Maintenance des poids suspendue');
   const previous=(await db.query('SELECT * FROM erplain_weight_repairs WHERE variant_id=$1',[String(v.id)])).rows[0];
   if(previous&&(previous.sku!==v.sku||previous.product_id!==String(v.product.id)))throw Error('Identité différente du journal poids');
   // A restart/network failure never authorizes another mutation. Read it back.
   if(previous&&['submitting','uncertain'].includes(previous.state)){
    const read=await api.request(readVariant,{id:String(v.id)});v=read.Variant;
    if(!v||String(v.id)!==previous.variant_id||v.sku!==previous.sku||String(v.product?.id)!==previous.product_id||v.active!==true||v.product.active!==true)throw Error('Identité du rapprochement poids non vérifiée');
    if(!Object.hasOwn(v,'weight_amount')||!Object.hasOwn(v,'weight_unit'))throw Error('Lecture du poids Erplain incomplète : rapprochement différé');
    if(missingWeight(v.weight_amount))throw Error('Écriture poids incertaine : lecture seule, aucun rejeu');
    businessWeight(v.weight_amount,v.weight_unit);
    await db.query("UPDATE erplain_weight_repairs SET state='reconciled',after_value=$2,error=null,updated_at=now() WHERE variant_id=$1",[String(v.id),JSON.stringify(v)]);
   }else if(missingWeight(v.weight_amount)){
    // A confirmed earlier repair may be followed by a new absence. Its proof
    // stays in history; a submitting/uncertain repair is never eligible here.
    // Finish an accepted unit (including readback) naturally during a deployment
    // pause. Stop before the next unit, not between its durable claim and send.
    const result=await fillMissingVariantWeight(api,{id:String(v.id),sku:v.sku,productId:String(v.product.id)},{checkpoint:async record=>{
     if(record.state==='submitting'){
      const claimed=await db.query(`INSERT INTO erplain_weight_repairs(variant_id,sku,product_id,state,before_value,attempted_at) VALUES($1,$2,$3,'submitting',$4,now())
       ON CONFLICT(variant_id) DO UPDATE SET state='submitting',before_value=excluded.before_value,after_value=null,error=null,attempted_at=now(),updated_at=now(),
        history=erplain_weight_repairs.history||jsonb_build_array(jsonb_build_object('state',erplain_weight_repairs.state,'before',erplain_weight_repairs.before_value,'after',erplain_weight_repairs.after_value,'attemptedAt',erplain_weight_repairs.attempted_at))
       WHERE erplain_weight_repairs.state IN ('verified','reconciled') AND erplain_weight_repairs.sku=excluded.sku AND erplain_weight_repairs.product_id=excluded.product_id RETURNING variant_id`,[String(v.id),v.sku,String(v.product.id),JSON.stringify(record.before)]);
      if(claimed.rows.length!==1)throw Error('Tentative poids déjà enregistrée : aucun rejeu');
     }else if(record.state!=='preserved')await db.query('UPDATE erplain_weight_repairs SET state=$2,after_value=$3,updated_at=now() WHERE variant_id=$1',[String(v.id),record.state,record.after?JSON.stringify(record.after):null]);
    }});
    v=result.variant;
   }
   await cache(db,v);
   // Reconcile only existing identity bindings; never select a product for a BC.
   const orders=(await db.query(`SELECT DISTINCT o.id FROM orders o JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE NOT o.archived AND o.channel<>'tender' AND coalesce(o.source_payload->>'erplainImported','false')<>'true' AND coalesce(l.target_sku,m.target_sku,l.source_sku)=$1`,[v.sku])).rows;
   const proof={sku:v.sku,live_variant_id:String(v.id),product:v,verified_at:new Date(now()).toISOString()};
   for(const o of orders)await reconcile(db,v.sku,o.id,proof);
   return v;
  });
 }
 async function scanPage(){
  const cursor=(await db.query("SELECT value FROM settings WHERE key='product_weight_scan'")).rows[0]?.value||{};
  if(cursor.nextAt&&Date.parse(cursor.nextAt)>now())return;
  const page=Number(cursor.page)||1;
  const {Variants:v}=await guarded('query V3WeightInventory($page:Int!){Variants(first:100,page:$page){data{sku active product{active}} paginatorInfo{lastPage hasMorePages}}}',{page});
  if(!Array.isArray(v?.data)||!Number.isInteger(v.paginatorInfo?.lastPage)||v.paginatorInfo.lastPage<1||v.paginatorInfo.lastPage>10000)throw Error('Inventaire poids incomplet');
  const skus=[...new Set(v.data.filter(v=>v.active===true&&v.product?.active===true&&v.sku?.trim()).map(v=>v.sku.trim()))];
  if(skus.length)await db.query('INSERT INTO erplain_weight_checks(sku) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING',[skus]);
  const next=page<v.paginatorInfo.lastPage?{page:page+1}:{page:1,nextAt:new Date(now()+86400000).toISOString()};
  await db.query("INSERT INTO settings(key,value) VALUES('product_weight_scan',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(next)]);
 }
 return {async run(){
  if(running||!enabled())return;running=true;
  const report={at:new Date(now()).toISOString(),checked:0,errors:[]};
  try{
   await api.verify();if(!enabled())return;
   // Demand takes priority; catalogue traversal covers products without orders too.
   await db.query(`INSERT INTO erplain_weight_checks(sku) SELECT DISTINCT coalesce(l.target_sku,m.target_sku,l.source_sku) FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE NOT o.archived AND coalesce(l.target_sku,m.target_sku,l.source_sku)<>'' ON CONFLICT DO NOTHING`);
   const candidates=(await db.query(`SELECT w.sku FROM erplain_weight_checks w LEFT JOIN catalog_results c ON c.sku=w.sku WHERE w.checked_at IS NULL OR w.checked_at<now()-interval '24 hours' OR (c.checked_at>w.checked_at AND coalesce(c.message,'') ~* 'poids|weight') ORDER BY (coalesce(c.message,'') ~* 'poids|weight') DESC,w.checked_at NULLS FIRST,w.sku LIMIT $1`,[batchSize])).rows;
   for(const {sku} of candidates){
    if(!enabled())break;
    let error=null;
    try{
     const result=await guarded(lookup,{where:{column:'SKU',operator:'EQ',value:sku}}),variants=result.Variants;
     if(!Array.isArray(variants?.data)||variants.paginatorInfo?.hasMorePages!==false||variants.data.length>=100||variants.data.some(v=>v.sku!==sku))throw Error('Recherche poids incomplète');
     const pins=(await db.query('SELECT live_variant_id FROM erplain_product_bindings WHERE sku=$1 UNION SELECT live_variant_id FROM product_weight_overrides WHERE sku=$1',[sku])).rows.map(r=>String(r.live_variant_id));
     const active=variants.data.filter(v=>v.active===true&&v.product?.active===true);
     const selected=pins.length?active.filter(v=>pins.every(id=>id===String(v.id))):active;
     if(selected.length!==1)throw Error('Poids : identité produit absente ou ambiguë');
     await maintain(selected[0]);report.checked++;
    }catch(e){error=String(e.message).slice(0,500);report.errors.push({sku,error});}
    await db.query('UPDATE erplain_weight_checks SET checked_at=now(),error=$2 WHERE sku=$1',[sku,error]);
   }
   if(enabled())await scanPage();
  }catch(e){report.error=String(e.message).slice(0,500);}
  finally{running=false;await db.query("INSERT INTO settings(key,value) VALUES('product_weight_maintenance',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(report)]);}
  return report;
 }};
}
