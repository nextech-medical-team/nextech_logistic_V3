import {assertFullOrderStock} from './stock-gate.mjs';

// The same fresh stock gate protects both full and partial BL creation.
// A historical BC debit is never a substitute for currently usable stock.
// Existing BLs must not pass this gate again to obtain their label.
export async function readBeforeBlStock(api,bcId,{selection}={}){
 const id=String(bcId||'');
 if(!/^\d+$/.test(id))throw Error('Stock non vérifiable : BC absent');
 const {Order:bc}=await api.request('query V3BeforeBlStock($id:ID!){Order(id:$id){id line_items{id type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}}}',{id});
 if(String(bc?.id)!==id||!Array.isArray(bc.line_items)||!bc.line_items.length)throw Error('Stock non vérifiable : lignes du BC absentes');
 let lines=bc.line_items.filter(l=>l.type!=='shipping_cost');
 if(selection){
  if(!Array.isArray(selection)||!selection.length)throw Error('Stock non vérifiable : sélection vide');
  const seen=new Set();
  lines=selection.map(s=>{
   const matches=lines.filter(l=>String(l.id)===String(s.lineId));
   if(matches.length!==1||seen.has(String(s.lineId)))throw Error('Stock non vérifiable : ligne sélectionnée ambiguë');
   seen.add(String(s.lineId));
   return {...matches[0],quantity:s.quantity};
  });
 }
 if(!lines.length||lines.some(l=>!l.variant?.id))throw Error('Stock non vérifiable : produits absents');
 assertFullOrderStock(lines);
 return {policy:'current_usable_before_bl',bcId:id,checkedAt:new Date().toISOString(),lines:lines.map(l=>({lineId:l.id,sku:l.variant.sku,variantId:l.variant.id,locationId:l.location?.id,quantity:l.quantity,available:l.available,onHand:l.on_hand,reserved:l.reserved_quantity,tracked:l.variant.track_inventory!==false}))};
}
