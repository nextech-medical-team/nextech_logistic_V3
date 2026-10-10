import {cancellationBlock} from './erp-transient-policy.mjs';
export function assertSellerRepairScope(o,b){
 if(o.channel!=='temu'||o.archived||o.partial_mode||cancellationBlock(o)||Object.hasOwn(o.source_payload||{},'marketplacePendingCorrection'))throw Error('Correction prix différée : annulation, archivage, livraison partielle ou modification plateforme');
 if(String(b?.id)!==String(o.erp_live?.bc?.id)||![o.reference,'V3:'+o.id].includes(b.external_reference))throw Error('Correction prix différée : identité ou référence BC différente');
 if(b.invoices_count==null||b.paid_amount==null||Number(b.invoices_count)!==0||Number(b.paid_amount)!==0)throw Error('Correction prix différée : BC facturé, payé ou contrôle incomplet');
 if(!['active','pending','unpublished'].includes(b.status))throw Error('Correction prix différée : statut BC non modifiable');
 if(/^creating|^publishing/.test(o.erp_live?.phase||''))throw Error('Correction prix différée : création externe à rapprocher');
 return true;
}
