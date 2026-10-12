import {temuOrderApiPaused,pausedTemuOrderApi} from './temu-order-api-policy.mjs';
import {marketplaceContentFrozen,retirePostBcSourceReview} from './marketplace-content-freeze.mjs';
import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
import {normalizeTemuReceipt} from './marketplace-inbox.mjs';
export async function acceptMarketplaceChange(db,id,actor){
 return db.transaction(async tx=>{
  const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(order?.channel==='temu'&&await temuOrderApiPaused())throw pausedTemuOrderApi();
  if(marketplaceContentFrozen(order)){await retirePostBcSourceReview(tx,order);return {contentFrozen:true,message:'BC rempli : contenu conservé, ancien contrôle plateforme retiré.'};}
  const pending=order?.source_payload?.marketplacePendingCorrection;if(!pending)throw Error('Aucune modification de plateforme en attente');
  if(order.archived||order.partial_mode||order.erp_live?.bc?.id||order.erp_live?.bl?.id)throw Error('Documents déjà préparés : comparer la commande avec les BC et BL avant modification');
  if((await tx.query('SELECT order_id FROM carrier_jobs WHERE order_id=$1',[id])).rows.length)throw Error('Traitement transport existant : vérifier le colis avant modification');
  if((await tx.query("SELECT order_id FROM erp_live_jobs WHERE order_id=$1 AND status IN ('processing','review')",[id])).rows.length)throw Error('Traitement Erplain à vérifier avant modification');
  if(order.channel==='temu'&&(await tx.query('SELECT reference FROM temu_label_jobs WHERE reference=$1',[order.reference])).rows.length)throw Error('Préparation TEMU existante : vérifier le colis avant modification');
  const normalized=order.channel==='shopify'?normalizeShopifyOrders([pending])[0]:order.channel==='temu'?normalizeTemuReceipt(pending,String(order.source_payload.sourceShop||order.source_payload.mallId)):null;
  if(!normalized||normalized.reference!==order.reference)throw Error('Nouvelle commande non vérifiable : préparation maintenue en pause');
  const oldLines=(await tx.query('SELECT source_sku,quantity FROM lines WHERE order_id=$1',[id])).rows;
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'marketplace.change.accepted',$2)",[actor,JSON.stringify({orderId:id,previousAddress:order.address,previousLines:oldLines})]);
  await tx.query('DELETE FROM lines WHERE order_id=$1',[id]);
  for(const line of normalized.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[line.id,id,line.source_line,line.source_sku,line.quantity,JSON.stringify(line.source_payload)]);
  await tx.query("UPDATE orders SET recipient=$2,address=$3,source_date=$4,source_payload=(source_payload-'marketplacePendingCorrection')||$5::jsonb,weight_kg=null,label_status='pending',issue=null,resolution_pending_resume=true WHERE id=$1",[id,normalized.recipient,JSON.stringify(normalized.address),normalized.source_date,JSON.stringify(normalized.source_payload)]);
  return {message:'Nouvelles données enregistrées. La préparation doit maintenant être recontrôlée.'};
 });
}
