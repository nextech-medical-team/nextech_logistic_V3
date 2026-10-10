import {assertDocumentIdle} from './erplain-document-read.mjs';
import {refreshErplainDocuments} from './erplain-documents-sync.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

function totals(items){
 if(!Array.isArray(items))throw Error('Lignes de stock invalides');
 const sums=new Map();for(const l of items){if(!l?.variant)continue;const valid=(typeof l.quantity==='number'&&Number.isFinite(l.quantity))||(typeof l.quantity==='string'&&/^\d+(?:\.\d+)?$/.test(l.quantity));const q=Number(l.quantity);if(!valid||!l.variant.id||!l.location?.id||!Number.isFinite(q)||q<0)throw Error('Lignes de stock invalides');const key=String(l.variant.id)+':'+String(l.location.id);const sum=(sums.get(key)||0)+q;if(!Number.isFinite(sum))throw Error('Quantités de stock invalides');sums.set(key,sum)}
 if(!sums.size||![...sums.values()].some(q=>q>0))throw Error('Aucune quantité de stock positive identifiable');return [...sums].sort();
}
export function assertCancelledStockAssociation(bc,bl,stock,pointer){
 if(!bc||bl?.status!=='cancelled'||bc.update_stock!==false||bl.update_stock!==false)throw Error('BL annulé avec sortie de stock séparée requis');
 if(!Array.isArray(bl.orders?.data)||bl.orders.data.length!==1||bl.orders.paginatorInfo?.hasMorePages!==false||String(bl.orders.data[0].id)!==String(bc.id))throw Error('BL non rattaché exclusivement au BC : pagination complète requise');
 if(!stock||String(stock.id)!==String(pointer.id)||stock.label!==pointer.label)throw Error('Sortie de stock non identifiée');
 if(!['completed','cancelled'].includes(stock.status)||stock.update_stock!==true)throw Error('État de sortie de stock non confirmé');
 if(JSON.stringify(totals(bl.line_items))!==JSON.stringify(totals(stock.line_items)))throw Error('Quantités BL et sortie de stock différentes : rapprochement manuel requis');
}
// Explicit repair only: refresh and preview remain read-only in Erplain.
export async function restoreCancelledDeliveryStock(db,api,id,stockId,{lock=withShipmentLock,refresh=refreshErplainDocuments,requireCancelledBC=false}={}){
 return lock(async()=>{
  await assertDocumentIdle(db,id);const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o?.erp_live?.bc?.id)throw Error('BC Erplain requis');
  const deliveries=(await db.query('SELECT * FROM partial_deliveries WHERE order_id=$1',[id])).rows;
  const candidates=deliveries.filter(d=>String(d.stock_document?.id)===String(stockId)&&d.bl?.id).map(d=>({bl:d.bl,stock:d.stock_document}));
  if(o.erp_live.bl?.id&&String(o.erp_live.stockDocument?.id)===String(stockId)&&!candidates.length)candidates.push({bl:o.erp_live.bl,stock:o.erp_live.stockDocument});
  if(candidates.length!==1)throw Error('Lien V3 entre BL et sortie de stock absent ou ambigu');const d=candidates[0];
  await api.verify();const read=async()=>api.request('query V3CancelledStockProof($bc:ID!,$bl:ID!,$stock:ID!){Order(id:$bc){id status update_stock} ShippingOrder(id:$bl){id label status update_stock orders(first:100){data{id} paginatorInfo{hasMorePages}} line_items{quantity variant{id} location{id}}} StockRemoval(id:$stock){id label status update_stock line_items{quantity variant{id} location{id}}}}',{bc:String(o.erp_live.bc.id),bl:String(d.bl.id),stock:String(stockId)});
  const assertProof=proof=>{
   if(String(proof?.Order?.id)!==String(o.erp_live.bc.id))throw Error('BC enregistré différent du document Erplain');
   if(String(proof?.ShippingOrder?.id)!==String(d.bl.id)||proof.ShippingOrder.label!==d.bl.label)throw Error('BL enregistré différent du document Erplain');
   if(requireCancelledBC&&proof.Order.status!=='cancelled')throw Error('BC annulé confirmé requis avant restitution automatique');
   assertCancelledStockAssociation(proof.Order,proof.ShippingOrder,proof.StockRemoval,d.stock);
  };
  const before=await read();assertProof(before);
  await assertDocumentIdle(db,id);
  if(before.StockRemoval.status!=='cancelled'){
   // Never retry an uncertain mutation. A subsequent user action first reads its outcome.
   try{await api.request('mutation V3RestoreCancelledStock($id:ID!,$input:StockAdjustmentInput!){UpdateStockRemoval(id:$id,input:$input){id label status update_stock}}',{id:String(stockId),input:{status:'cancelled'}})}catch(e){throw Error('Restitution non confirmée : actualisez Erplain avant toute nouvelle tentative. '+e.message)}
  }
  const after=await read();assertProof(after);if(after.StockRemoval.status!=='cancelled')throw Error('Annulation de la sortie de stock non confirmée');
  const result=await refresh(db,api,id);return {...result,restoredStockId:String(stockId),replayed:before.StockRemoval.status==='cancelled',message:'Sortie de stock du BL '+after.ShippingOrder.label+' annulée dans Erplain ; quantités et allocations actualisées. Ancienne étiquette conservée.'};
 });
}
