import {withShipmentLock} from './shipment-lock.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';
import {assertCancelledStockAssociation,restoreCancelledDeliveryStock} from './cancelled-delivery-stock.mjs';
import {suspensionBlock} from './order-suspension.mjs';

const preflightErrors=new Set(['Appels d’offres · Client et destinataire dépassent les trois lignes GLS : vérifier avant création','Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS']);
export function assertPartialCancellation(order,d,blId){
 if(!order?.erp_live?.bc?.id||!d||d.order_id!==order.id||String(d.bl?.id)!==String(blId))throw Error('BL partiel différent de la demande : actualiser avant annulation');
 if(suspensionBlock(order)||order.archived||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))throw Error('Commande suspendue, annulée ou déjà expédiée');
 if(order.channel==='temu'||order.channel==='relay')throw Error('Annulation à effectuer dans le parcours du canal');
 if(!['bl_ready','cancelled'].includes(d.status)&&!(d.status==='review'&&(['bl_ready','finalizing_bl','cancelling_bl','restoring_cancelled_stock'].includes(d.stage)||d.stage==='creating_label'&&preflightErrors.has(d.error))))throw Error('Résultat transporteur incertain ou traitement actif : rapprochement requis avant annulation');
 if(!Array.isArray(d.tracking)||d.tracking.length||d.carrier_result||Number(d.documents)!==0)throw Error('Étiquette ou résultat transporteur existant : annulation de ce BL refusée');
 if(!d.stock_document?.id)throw Error('Sortie de stock séparée non identifiée : rapprochement requis');
}
export function assertPartialCancellationProof(order,d,proof){
 const bc=proof?.Order,bl=proof?.ShippingOrder;
 if(String(bc?.id)!==String(order.erp_live.bc.id)||!['active','pending','open','in_progress','confirmed'].includes(bc.status))throw Error('BC actif non confirmé dans Erplain');
 if(String(bl?.id)!==String(d.bl.id)||bl.label!==d.bl.label||!['pending','make_the_shipment','in_preparation','ready_to_ship','cancelled'].includes(bl.status))throw Error('BL non identifiable, expédié ou statut non annulable');
 if(!(bl.invoices_count===0||bl.invoices_count==='0')||!Array.isArray(bl.invoices?.data)||bl.invoices.data.length||bl.invoices.paginatorInfo?.hasMorePages!==false)throw Error('Facturation du BL présente ou non vérifiable : annulation refusée');
 assertCancelledStockAssociation(bc,{...bl,status:'cancelled'},proof.StockRemoval,d.stock_document);
}
// Explicit user action only. Never enqueue this operation or replay uncertain writes.
export async function cancelPartialDelivery(db,api,input,{lock=withShipmentLock,restore=restoreCancelledDeliveryStock}={}){
 return lock(async()=>{
  const {id,deliveryId,blId}=input||{};if(!id||!deliveryId||!/^\d+$/.test(String(blId)))throw Error('Commande et BL partiel requis');
  const local=async()=>{await assertDocumentIdle(db,id);const order=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];const d=(await db.query('SELECT d.*,(SELECT count(*)::int FROM partial_documents p WHERE p.delivery_id=d.id) documents FROM partial_deliveries d WHERE d.id=$1 AND d.order_id=$2',[deliveryId,id])).rows[0];assertPartialCancellation(order,d,blId);return {order,d};};
  const {order,d}=await local();const company=await api.verify();if(Number(company?.id)!==100174)throw Error('Écriture interdite hors Erplain LIVE');
  const read=()=>api.request('query V3PartialCancellationProof($bc:ID!,$bl:ID!,$stock:ID!){Order(id:$bc){id status update_stock} ShippingOrder(id:$bl){id label status update_stock invoices_count invoices(first:100){data{id} paginatorInfo{hasMorePages}} orders(first:100){data{id} paginatorInfo{hasMorePages}} line_items{quantity variant{id} location{id}}} StockRemoval(id:$stock){id label status update_stock line_items{quantity variant{id} location{id}}}}',{bc:String(order.erp_live.bc.id),bl:String(blId),stock:String(d.stock_document.id)});
  const before=await read();assertPartialCancellationProof(order,d,before);const latest=await local();if(String(latest.order.erp_live.bc.id)!==String(order.erp_live.bc.id)||JSON.stringify(latest.d.bl)!==JSON.stringify(d.bl)||JSON.stringify(latest.d.stock_document)!==JSON.stringify(d.stock_document)||latest.d.stage!==d.stage||latest.d.status!==d.status)throw Error('Documents modifiés pendant la lecture : actualiser avant annulation');
  if(before.ShippingOrder.status!=='cancelled'){
   if(['cancelling_bl','restoring_cancelled_stock'].includes(d.stage))throw Error('Annulation antérieure incertaine : BL toujours actif, aucun nouvel envoi. Rapprocher le résultat Erplain.');
   const marked=await db.query("UPDATE partial_deliveries SET status='review',stage='cancelling_bl',error='Annulation demandée : résultat Erplain à rapprocher',updated_at=now() WHERE id=$1 AND status=$2 AND stage IS NOT DISTINCT FROM $3 RETURNING id",[d.id,d.status,d.stage]);
   if(marked.rows.length!==1)throw Error('Livraison modifiée pendant le contrôle : annulation différée');
   try{await api.request('mutation V3CancelPartialBL($ids:[ID!]!,$status:ShippingOrderStatus!){UpdateShippingOrdersStatus(ids:$ids,status:$status)}',{ids:[String(blId)],status:'cancelled'});}catch(error){throw Error('Annulation du BL non confirmée : actualiser Erplain avant toute nouvelle tentative. '+error.message);}
  }
  const after=await read();assertPartialCancellationProof(order,d,after);if(after.ShippingOrder.status!=='cancelled')throw Error('Annulation du BL non confirmée dans Erplain : aucune restitution effectuée');
  // Reuse the existing exclusive BL/BC/stock proof and confirmed stock restoration.
  if(d.stage==='restoring_cancelled_stock'&&after.StockRemoval.status!=='cancelled')throw Error('Restitution antérieure incertaine : aucune nouvelle écriture de stock. Rapprocher le résultat Erplain.');
  await db.query("UPDATE partial_deliveries SET status='review',stage='restoring_cancelled_stock',error='Restitution demandée : résultat Erplain à rapprocher',updated_at=now() WHERE id=$1",[d.id]);
  const result=await restore(db,api,id,String(d.stock_document.id),{allowMarkedAttempt:d.stage!=='restoring_cancelled_stock'});
  return {blId:String(blId),deliveryId,replayed:before.ShippingOrder.status==='cancelled',message:'BL '+after.ShippingOrder.label+' annulé et sortie de stock restituée. Les quantités du BC sont de nouveau préparables selon le stock actuel. Anciennes étiquettes conservées.',stockHolds:result.stockHolds};
 });
}
