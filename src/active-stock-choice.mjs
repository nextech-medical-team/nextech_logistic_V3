// Resolve only an unbound SKU. Existing document and explicit binding IDs take
// precedence at the caller and must never be replaced by a changing stock rank.
export function chooseActiveStockVariant(variants,{sku,locationId,variantId}={}){
 if(!Array.isArray(variants)||!sku||!locationId)throw Error('Sélection produit : catalogue ou emplacement incomplet');
 const active=variants.filter(v=>v.sku===sku&&v.active===true&&v.product?.active===true);
 if(!active.length)throw Error('Produit actif Erplain introuvable : '+sku);
 if(variantId!=null){
  const bound=active.filter(v=>String(v.id)===String(variantId));
  if(bound.length!==1)throw Error('Produit Erplain lié absent, inactif ou ambigu : '+sku);
  return {variant:bound[0],reason:'explicit-binding'};
 }
 if(active.length===1)return {variant:active[0],reason:'unique'};
 const seen=new Set();
 const ranked=active.map(variant=>{
  const id=String(variant.id||'');
  if(!/^\d+$/.test(id)||seen.has(id))throw Error('Sélection produit : identifiant catalogue ambigu');seen.add(id);
  const levels=variant.stock_levels;
  if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false)throw Error('Sélection produit : stock incomplet pour '+sku);
  const here=levels.data.filter(l=>String(l.location?.id)===String(locationId));
  if(here.length>1)throw Error('Sélection produit : emplacement en doublon');
  // A complete list with no level at this warehouse represents no stock here.
  // Never borrow stock from another warehouse to rank a shipping candidate.
  let usable=0;
  if(here.length){const {available,on_hand}=here[0];if([available,on_hand].some(value=>!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))))throw Error('Sélection produit : quantité de stock inconnue');usable=Math.max(0,Math.min(Number(available),Number(on_hand)));}
  return {variant,usable};
 });
 ranked.sort((a,b)=>b.usable-a.usable||(BigInt(a.variant.id)<BigInt(b.variant.id)?-1:1));
 return {...ranked[0],reason:'highest-usable-stock',locationId:String(locationId)};
}
