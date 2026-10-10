import {shippingProductLines} from './erplain-shipping-lines.mjs';
// Preserve the BC commercial snapshot; only the pending BL is admitted to preparation.
export function pendingScope(d,{preparedBlId=null}={}){
 const all=shippingProductLines(d.line_items||[]),connection=d.shipping_orders;
 if(!Array.isArray(connection?.data)||connection.paginatorInfo?.hasMorePages!==false)throw Error('Liste des BL incomplète : récupération bloquée');
 const pending=connection.data.filter(b=>b.status==='pending'||preparedBlId&&String(b.id)===String(preparedBlId)&&['make_the_shipment','in_preparation','ready_to_ship'].includes(b.status));
 const finished=connection.data.filter(b=>['shipped','delivered','completed'].includes(b.status));
 if(!pending.length){
  if(finished.length||all.some(l=>Number(l.shipped_quantity)>0))throw Error('Aucun BL en attente : les quantités déjà expédiées ou livrées ne sont pas récupérées');
  return {lines:all,pending:[],finished,scoped:false};
 }
 const completedQuantities=new Map();
 for(const bl of finished){
  if(!Array.isArray(bl.line_items))throw Error('Quantités des BL terminés non reçues');
  for(const item of shippingProductLines(bl.line_items)){
   const matches=all.filter(l=>item.parent_id?String(l.id)===String(item.parent_id):String(l.variant?.id)===String(item.variant?.id));
   const q=Number(item.quantity);
   if(matches.length!==1||!Number.isFinite(q)||q<0)throw Error('Quantités déjà livrées à rapprocher');
   const key=String(matches[0].id);completedQuantities.set(key,(completedQuantities.get(key)||0)+q);
  }
 }
 const quantities=new Map();
 for(const bl of pending){
  if(!bl.id||!Array.isArray(bl.line_items))throw Error('BL en attente incomplet');
  for(const item of shippingProductLines(bl.line_items)){
   let matches=item.parent_id?all.filter(l=>String(l.id)===String(item.parent_id)):[];
   if(!matches.length)matches=all.filter(l=>String(l.variant?.id)===String(item.variant?.id));
   if(matches.length!==1||String(matches[0].variant?.id)!==String(item.variant?.id))throw Error('Ligne du BL en attente ambiguë : rapprochement requis');
   const q=Number(item.quantity),line=matches[0];
   if(!Number.isFinite(q)||q<=0)throw Error('Quantité du BL en attente invalide');
   quantities.set(String(line.id),(quantities.get(String(line.id))||0)+q);
  }
 }
 const lines=all.filter(l=>quantities.has(String(l.id))).map(l=>{
  const quantity=quantities.get(String(l.id)),ordered=Number(l.quantity),shipped=completedQuantities.get(String(l.id))||0;
  if(!Number.isFinite(ordered)||!Number.isFinite(shipped)||shipped<0||quantity>ordered-shipped+1e-6)throw Error('Quantités du BL en attente incompatibles avec le reliquat du BC');
  return {...l,quantity,shipped_quantity:0};
 });
 if(!lines.length)throw Error('BL en attente sans ligne produit');
 return {lines,pending,finished,scoped:true};
}
export function scopeSnapshot(d,scope=pendingScope(d)){
 return {...d,shipping_orders:{...d.shipping_orders,data:scope.scoped?scope.pending:d.shipping_orders.data},excluded_shipping_orders:scope.finished,pendingScope:scope.scoped};
}

// Existing imports may continue their already selected BL after preparation.
// Initial admission still accepts pending only; shipped/delivered never enter.
export function recoveredPendingScope(d,o){
 const id=o?.erp_live?.bl?.id,selected=o?.erp_live?.pendingBlIds||[];
 if(o?.source_payload?.erplainImported!==true||o.source_payload.account!=='live'||!id||!selected.map(String).includes(String(id)))return pendingScope(d);
 if(String(d?.id)!==String(o.erp_live.bc?.id))throw Error('BC de la livraison sélectionnée non confirmé');
 if(!Array.isArray(d.shipping_orders?.data)||d.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Liste des BL incomplète : récupération bloquée');
 const matches=d.shipping_orders.data.filter(b=>String(b.id)===String(id));
 if(matches.length!==1||!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(matches[0].status))throw Error('BL sélectionné absent ou déjà expédié : rapprochement requis');
 if(d.shipping_orders.data.some(b=>b.status==='pending'&&!selected.map(String).includes(String(b.id))))throw Error('Nouveau BL en attente : rapprochement requis');
 return pendingScope(d,{preparedBlId:String(id)});
}
