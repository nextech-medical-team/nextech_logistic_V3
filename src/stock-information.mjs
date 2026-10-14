import {stockChoiceLocation} from './stock-choice-location.mjs';

const quantity=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))?Number(value):null;
export async function readStockInformationProduct(api,sku,locationId){
 const response=await api.request('query V3StockInformation($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku active track_inventory product{id label active} stock_levels(first:100){data{location{id} available on_hand incoming} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:sku}});
 const variants=response.Variants;
 if(!Array.isArray(variants?.data)||variants.paginatorInfo?.hasMorePages!==false||variants.data.some(v=>v.sku!==sku||typeof v.active!=='boolean'||typeof v.product?.active!=='boolean'))throw Error('Produit non vérifié');
 const active=variants.data.filter(v=>v.active&&v.product.active);
 if(active.length!==1)throw Error(active.length?'Plusieurs produits actifs pour ce SKU':'Produit actif non retrouvé');
 const v=active[0],levels=v.stock_levels;
 if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false)throw Error('Stock incomplet');
 const here=levels.data.filter(s=>String(s.location?.id)===locationId);
 if(here.length!==1)throw Error(here.length?'Emplacement en doublon':'Stock de cet emplacement non vérifié');
 const s=here[0],available=quantity(s.available),physical=quantity(s.on_hand),incoming=quantity(s.incoming);
 return {sku,label:v.product.label||sku,variantId:String(v.id),locationId,available:v.track_inventory===true&&available!==null&&physical!==null?Math.max(0,Math.min(available,physical)):null,incoming:incoming!==null&&incoming>=0?incoming:null,stockTracked:v.track_inventory===true};
}

export function stockInformationService(db,api,directory,{location=()=>stockChoiceLocation(directory),now=Date.now}={}){
 const cache=new Map();
 async function read(sku,locationId){
  const rows=(await db.query('SELECT sku_a,sku_b FROM product_equivalences WHERE active AND (sku_a=$1 OR sku_b=$1) ORDER BY sku_a,sku_b',[sku])).rows;
  const equivalentSkus=[...new Set(rows.map(r=>r.sku_a===sku?r.sku_b:r.sku_a))].filter(s=>s!==sku);
  await api.verify();
  const product=async target=>{try{return await readStockInformationProduct(api,target,locationId);}catch{return {sku:target,incoming:null,available:null,error:'Lecture ERPLAIN non vérifiée'};}};
  const original=await product(sku),equivalents=[];
  // Bounded reads; recorded equivalences only, no implicit matching or replacement.
  for(const target of equivalentSkus.slice(0,20))equivalents.push(await product(target));
  return {sku,locationId,original,equivalents,equivalentCount:equivalentSkus.length,checkedAt:new Date(now()).toISOString(),expiresAt:new Date(now()+300000).toISOString()};
 }
 return {async get(sku){
  if(typeof sku!=='string'||!sku.trim()||sku.length>199)throw Error('SKU Erplain requis');sku=sku.trim();
  const locationId=String(await location()),key=JSON.stringify([sku,locationId]);
  const existing=cache.get(key);if(existing&&existing.until>now())return existing.promise;
  if(cache.size>=500)cache.delete(cache.keys().next().value);
  const entry={until:now()+300000,promise:null};
  entry.promise=read(sku,locationId).then(result=>{entry.until=Date.parse(result.expiresAt);return result;},error=>{cache.delete(key);throw error;});cache.set(key,entry);
  return entry.promise;
 }};
}
