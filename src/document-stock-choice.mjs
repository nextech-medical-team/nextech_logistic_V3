import {chooseActiveStockVariant} from './active-stock-choice.mjs';
// A document records a physical variant, not merely a SKU spelling. Never
// replace that variant implicitly when the stock ranking later changes.
export function chooseDocumentStockVariant(variants,{sku,locationId,document,variantId}={}){
 // A prior global SKU binding is not a permanent stock-choice override.
 // Only an existing document pins the physical variant for this order.
 let selectedId;
 if(document!=null){
  if(!document.id||!Array.isArray(document.line_items))throw Error('Sélection produit : lignes du BC non vérifiées');
  const normal=document.line_items.filter(l=>l.type==='normal');
  if(normal.some(l=>!l.variant?.id||!l.variant?.sku||!l.location?.id))throw Error('Sélection produit : identité des produits du BC incomplète');
  const matching=normal.filter(l=>l.variant.sku===sku);
  if(matching.length){
   const ids=new Set(matching.map(l=>String(l.variant.id))),locations=new Set(matching.map(l=>String(l.location.id)));
   if(ids.size!==1||locations.size!==1||!locations.has(String(locationId)))throw Error('Sélection produit : plusieurs variantes ou emplacements dans le BC, rapprochement requis');
   selectedId=[...ids][0];
  }
 }
 const choice=chooseActiveStockVariant(variants,{sku,locationId,variantId:selectedId});
 return {...choice,reason:document?.line_items?.some(l=>l.type==='normal'&&l.variant?.sku===sku)?'existing-document':choice.reason};
}
