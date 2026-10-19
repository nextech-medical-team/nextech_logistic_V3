import {assertDirectCarrierAllowed} from './temu-label-policy.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {parcelWeightKg} from './weight-arithmetic.mjs';
export function assertManualLabelOrder(o,carrier,{manualChoice=false}={}){const suspended=suspensionBlock(o);if(suspended)throw Error(suspended);
 if(!o)throw Error('Commande introuvable');
 assertDirectCarrierAllowed(o,carrier,{manualChoice});
 if(o.archived||o.tracking_status==='cancelled'||o.erp_live?.bc?.status==='cancelled')throw Error('Commande annulée ou archivée : création d’étiquette indisponible');
 if(o.partial_mode)throw Error('Choisir le transporteur dans la préparation de la livraison partielle concernée');
 if(['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status))throw Error('Commande déjà expédiée : vérifier la livraison avant de créer une nouvelle étiquette');
 if(carrier==='gofo'&&String(o.address?.country).trim().toUpperCase()!=='FR')throw Error('GOFO : livraison en France uniquement ; choisir GLS');
}
export function assertTemuManualLabel(job){
 if(['purchasing','uncertain'].includes(job?.status))throw Error('Achat TEMU en cours ou incertain : vérifier son résultat avant une nouvelle étiquette');
}
// Read actual mapped product weights; the default TEMU parcel weight is not a measured weight.
export async function additionalLabelWeight(db,o){
 const rows=(await db.query(`SELECT l.source_sku,l.target_sku,l.target_quantity,l.quantity,m.source_qty,m.target_qty,coalesce((l.source_payload->>'erplainCorrectedWeightKg')::numeric,p.weight_kg) weight_kg FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku LEFT JOIN products p ON p.sku=coalesce(l.target_sku,m.target_sku,CASE WHEN $2 IN ('tender','samples') THEN l.source_sku END) WHERE l.order_id=$1`,[o.id,o.channel])).rows;
 if(!rows.length)throw Error('Articles absents : poids du colis non vérifiable');
 let weight=0;
 for(const l of rows){const q=Number(l.target_quantity??(l.source_qty?Number(l.quantity)*Number(l.target_qty)/Number(l.source_qty):l.quantity)),w=Number(l.weight_kg);if(!Number.isFinite(w)||w<=0||!Number.isFinite(q)||q<=0)throw Error((l.target_sku||l.source_sku)+' · Poids ou quantité manquant');weight+=w*q;}
 if(!Number.isFinite(weight)||weight<=0)throw Error('Poids du colis invalide');
 return parcelWeightKg(weight);
}
