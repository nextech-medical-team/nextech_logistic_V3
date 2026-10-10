import {createHash} from 'node:crypto';
export const validatedDeliverySql=`erp_live->'bl'->>'id' IS NOT NULL AND erp_live->'bl'->>'status' IN ('ready_to_ship','shipped','delivered','completed') AND erp_live->>'verifiedAt' IS NOT NULL AND erp_live->>'stockCheckedAt' IS NOT NULL AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=orders.id AND e.status='complete')`;
export async function shipmentFingerprint(db,o){
 const lines=(await db.query('SELECT source_sku,target_sku,quantity,target_quantity FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
 return createHash('sha256').update(JSON.stringify({id:o.id,address:o.address,weight:o.weight_kg,lines})).digest('hex');
}
export async function assertLabelStockGate(db,o,override){
 if(o.source_payload?.marketplacePendingCorrection)throw Error('Commande modifiée sur la plateforme : vérifier les nouvelles données avant étiquette');
 if(o.partial_mode)throw Error('Utiliser les quantités et le BL de la livraison partielle');
 if(override?.requestedBy&&override?.at&&override.fingerprint===await shipmentFingerprint(db,o))return;
 const allowed=(await db.query(`SELECT id FROM orders WHERE id=$1 AND ${validatedDeliverySql}`,[o.id])).rows.length;
 if(!allowed)throw Error('Étiquette bloquée : contrôle du stock et BL validé requis. En cas de stock insuffisant, utiliser le bouton dédié de dérogation.');
 if(!o.erp_live.labelPreparationFingerprint)throw Error('Validation de la préparation à actualiser avant étiquette.');
 if(o.erp_live.labelPreparationFingerprint!==await shipmentFingerprint(db,o))throw Error('Préparation modifiée depuis la validation du BL : recontrôler les quantités et le transport avant étiquette.');
}

