import {pendingScope,recoveredPendingScope} from './erplain-pending-scope.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
const identified=id=>(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)||(typeof id==='string'&&/^[1-9]\d*$/.test(id));

// The complete BC remains the commercial document; only pending quantities prepare.
export function resolutionBcLines(order,bc){
 if(!identified(order.erp_live?.bc?.id)||!identified(bc?.id)||String(bc.id)!==String(order.erp_live.bc.id))throw Error('API Erplain · Identité BC non confirmée');
 if(bc.status!=='active')throw Error('BC Erplain non actif : rapprochement requis');
 if(!order.source_payload?.erplainImported)return bc.line_items;
 const lines=shippingProductLines(bc.line_items||[]),ids=new Set();
 for(const l of lines){if(!identified(l.id)||!identified(l.variant?.id)||ids.has(String(l.id)))throw Error('Lignes BC non identifiées ou ambiguës');ids.add(String(l.id));}
 const blIds=new Set();
 for(const bl of bc.shipping_orders?.data||[]){
  if(!identified(bl.id)||blIds.has(String(bl.id)))throw Error('Identité BL absente ou ambiguë');blIds.add(String(bl.id));
  for(const l of shippingProductLines(bl.line_items||[])){
   if(!identified(l.variant?.id))throw Error('Identité produit BL absente');
   if(l.parent_id!=null&&(!identified(l.parent_id)||!lines.some(p=>String(p.id)===String(l.parent_id)&&String(p.variant.id)===String(l.variant.id))))throw Error('Lien BL et ligne BC non confirmé');
  }
 }
 return recoveredPendingScope(bc,order).lines;
}
