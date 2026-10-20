import {assertWholeTemuPackage} from './temu-label-pdf.mjs';
import {cancellationBlock} from './erp-transient-policy.mjs';

// A refused label permits an ERP-only substitution, never another purchase.
// Keep the original package and attempt so the purchase guard remains active.
export function verifiedRefusedSubstitutionPackage(order,job,lines,documents=[]){
 if(!order||order.archived||order.partial_mode||order.suspension?.active||cancellationBlock(order)||order.source_payload?.externalLabel?.active||order.source_payload?.marketplacePendingCorrection||order.source_payload?.visibilityHold||!order.erp_live?.bc?.id||order.erp_live.bl?.id||order.erp_live.stockDocument||/^(creating|publishing)/.test(order.erp_live.phase||'')||['shipped','delivered','in_transit','delivered_simulated'].includes(order.tracking_status))return false;
 if(order?.channel!=='temu'||job?.status!=='shipment_error'||job.result?.source!=='temu_direct'||job.packages?.length!==1||documents.length||!lines?.length)return false;
 if(!Number.isFinite(Date.parse(job.result.observedAt))||!/^PK-\d+$/.test(job.packages[0]))return false;
 const parcels=job.result.packageInfoResultList;
 if(!Array.isArray(parcels)||parcels.length!==1)return false;
 const p=parcels[0];
 if(p.packageSn!==job.packages[0]||Number(p.shippingLabelStatus)!==2||!/shipping address contains non-English characters/i.test(p.failReasonText||''))return false;
 if(p.trackingNumber||p.shipmentConfirmed||p.subPackageSnList?.length||p.subPackageShipmentInfoList?.length||job.result.deliveryStatuses?.length)return false;
 if(p.shippingInfoList?.some(s=>String(s.trackingNumber||'').trim()))return false;
 if(!p.orderSendInfoList?.length||p.orderSendInfoList.some(l=>l.parentOrderSn!==order.reference))return false;
 const originals=order.erp_live?.equivalentOriginalLines||lines;
 if(!originals.length||originals.some(l=>!l.source_line||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))return false;
 try{assertWholeTemuPackage(order,originals,job.result,p.packageSn);}catch{return false;}
 return true;
}

export const refusedSubstitutionNotice='Remplacement du BC uniquement. Étiquette TEMU refusée : corriger les coordonnées dans TEMU et récupérer le colis existant. Aucun nouvel achat automatique.';
