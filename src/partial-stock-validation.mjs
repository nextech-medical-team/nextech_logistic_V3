import {exactStockAvailability} from './stock-decimal.mjs';
export const partialStockNumeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
const enough=(quantity,limit)=>partialStockNumeric(quantity)&&Number(quantity)>0&&partialStockNumeric(limit)&&exactStockAvailability([{quantity,reserved_quantity:0,available:limit,on_hand:limit}]).sufficient;
export function validatePartialStock(lines,selection,unitPrice){
 if(!Array.isArray(selection)||!selection.length)throw Error('Sélectionner au moins une quantité');
 const seen=new Set(),groups=new Map();
 const chosen=selection.map(s=>{
  const l=lines.find(l=>l.lineId===String(s.lineId));
  if(!l||seen.has(l.lineId)||typeof l.tracked!=='boolean'||!enough(s.quantity,l.remaining)||!enough(s.quantity,l.available))throw Error('Quantité partielle invalide ou stock insuffisant : '+(l?.sku||s.lineId));
  seen.add(l.lineId);
  if(l.tracked){
   if(!l.variantId||!l.locationId)throw Error('Stock partiel non vérifiable : produit ou emplacement absent');
   const key=l.variantId+':'+l.locationId,g=groups.get(key)||{sku:l.sku,rows:[],snapshotRows:[],holds:null};
   g.rows.push({quantity:s.quantity,reserved_quantity:0,available:l.stockUsable,on_hand:l.stockUsable});
   if(l.stockSnapshot){
    const snap=l.stockSnapshot;
    if(![snap.on_hand,snap.available,snap.reserved_quantity].every(partialStockNumeric))throw Error('Stock partiel non vérifiable : '+l.sku);
    g.snapshotRows.push({quantity:s.quantity,on_hand:snap.on_hand,available:snap.available,reserved_quantity:snap.reserved_quantity});
    g.holds??=snap.heldQuantities||[];
   }
   groups.set(key,g);
  }
  return {...l,price:unitPrice(l.price,l.sku),quantity:Number(s.quantity)};
 });
 for(const g of groups.values()){
  if(!exactStockAvailability(g.rows).sufficient)throw Error('Stock cumulé insuffisant : '+g.sku);
  if(g.snapshotRows.length){
   if(g.snapshotRows.length!==g.rows.length)throw Error('Stock partiel non vérifiable : '+g.sku);
   if((g.holds||[]).some(q=>!partialStockNumeric(q)||Number(q)<=0))throw Error('Stock partiel non vérifiable : réservation locale invalide');
   const first=g.snapshotRows[0],held=(g.holds||[]).map(quantity=>({...first,quantity,reserved_quantity:0}));
   if(!exactStockAvailability([...g.snapshotRows,...held]).sufficient)throw Error('Stock cumulé insuffisant : '+g.sku);
  }
 }
 return chosen;
}
