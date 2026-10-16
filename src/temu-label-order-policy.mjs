import {suspensionBlock} from './order-suspension.mjs';
import {hasExternalLabel} from './temu-external-label.mjs';

// Labels are purchased on their own financial decision, independently of ERP
// preparation. The legacy simulation/import flag is not a supplier sandbox.
export function temuLabelOrderHold(o){
 if(!o||o.channel!=='temu'||o.archived)return 'Commande hors périmètre TEMU';
 const suspension=suspensionBlock(o);if(suspension)return suspension;
 if(o.label_status==='cancelled'||['cancelled','shipped','in_transit','delivered'].includes(o.tracking_status))return 'Commande annulée ou déjà expédiée';
 if(hasExternalLabel(o)||o.transport_choice)return 'Étiquette ou choix de transport existant à préserver';
 if(o.partial_mode)return 'Parcours partiel existant à préserver, aucun achat parent supplémentaire';
 return null;
}
export function assertTemuLabelOrder(o){const held=temuLabelOrderHold(o);if(held)throw Error(held);}

// Financial/source data used in the fresh margin remain unchanged at claim.
// Deliberately no BC, BL, stock, preparation, issue or simulation prerequisite.
export const positiveTemuClaimGuard=` AND EXISTS(SELECT 1 FROM orders o
 WHERE o.id=$4 AND o.reference=temu_label_jobs.reference AND o.channel='temu'
 AND NOT o.archived AND NOT o.partial_mode AND o.transport_choice IS NULL
 AND coalesce(o.tracking_status,'not_shipped') NOT IN ('cancelled','shipped','in_transit','delivered')
 AND coalesce(o.label_status,'')<>'cancelled'
 AND o.source_payload=$5::jsonb AND o.address=$6::jsonb AND o.suspension=$7::jsonb
 AND o.weight_kg IS NOT DISTINCT FROM $8::numeric
 AND coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY source_line,id) FROM lines l WHERE l.order_id=o.id),'[]'::jsonb)=$9::jsonb
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM temu_label_documents t WHERE t.reference=o.reference))`;
