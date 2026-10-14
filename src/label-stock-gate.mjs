import {usesRecordedBc as marketplaceContentFrozen} from './existing-bc-execution.mjs';
import {hasCreatedBl,createdBlSql} from './created-bl-label.mjs';
import {createHash} from 'node:crypto';
export const validatedDeliverySql=createdBlSql;
export async function shipmentFingerprint(db,o){
 const lines=marketplaceContentFrozen(o)?{authority:'recorded_bc',bcId:String(o.erp_live.bc.id)}:(await db.query('SELECT source_sku,target_sku,quantity,target_quantity FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
 return createHash('sha256').update(JSON.stringify({id:o.id,address:o.address,weight:o.weight_kg,lines})).digest('hex');
}
export async function assertLabelStockGate(db,o,override){
 if(o.partial_mode)throw Error('Utiliser les quantités et le BL de la livraison partielle');
 if(hasCreatedBl(o))return;
 if(!marketplaceContentFrozen(o)&&o.source_payload?.marketplacePendingCorrection)throw Error('Commande modifiée sur la plateforme : vérifier les nouvelles données avant étiquette');
 if(override?.requestedBy&&override?.at&&override.fingerprint===await shipmentFingerprint(db,o))return;
 const allowed=(await db.query(`SELECT id FROM orders WHERE id=$1 AND ${validatedDeliverySql}`,[o.id])).rows.length;
 if(!allowed)throw Error('Étiquette bloquée : contrôle du stock et BL validé requis.');
 if(marketplaceContentFrozen(o))return;
 if(!o.erp_live.labelPreparationFingerprint)throw Error('Validation de la préparation à actualiser avant étiquette.');
 if(o.erp_live.labelPreparationFingerprint!==await shipmentFingerprint(db,o))throw Error('Préparation modifiée depuis la validation du BL : actualiser la préparation du transport avant étiquette.');
}
