// A confirmed shipment is not proof of a printable label or of a new payment.
// This fallback only reads TEMU; it never changes an address or retries a purchase.
export async function readConfirmedTemuShipments(api,reference,packages){
 const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:reference});
 if(detail?.parentOrderMap?.parentOrderSn!==reference||!Array.isArray(detail.orderList)||!detail.orderList.length||![4,5].includes(Number(detail.parentOrderMap.parentOrderStatus)))return null;
 const parcels=new Map(),seenLines=new Set();
 for(const line of detail.orderList){
  if(!line.orderSn||seenLines.has(line.orderSn)||!line.skuId)return null;
  seenLines.add(line.orderSn);
  const response=await api.read('bg.logistics.shipment.v2.get',{parentOrderSn:reference,orderSn:line.orderSn});
  if(!Array.isArray(response?.shipmentInfoDTO)||!response.shipmentInfoDTO.length)return null;
  for(const p of response.shipmentInfoDTO){
   if(Number(p.packageDeliveryType)!==1||!packages.includes(p.packageSn)||p.parentOrderSn&&p.parentOrderSn!==reference||p.orderSn&&p.orderSn!==line.orderSn||String(p.skuId)!==String(line.skuId)||p.subPackageShipmentInfoList?.length||!String(p.trackingNumber||'').trim()||!p.carrierName)return null;
   const prior=parcels.get(p.packageSn);
   if(prior&&(prior.trackingNumber!==p.trackingNumber||prior.shippingCompanyName!==p.carrierName))return null;
   const parcel=prior||{packageSn:p.packageSn,trackingNumber:p.trackingNumber,shippingCompanyName:p.carrierName,carrier:p.carrierName,shipmentConfirmed:true,packageDeliveryType:1,orderSendInfoList:[]};
   if(!parcel.orderSendInfoList.some(l=>l.orderSn===line.orderSn))parcel.orderSendInfoList.push({parentOrderSn:reference,orderSn:line.orderSn});
   parcels.set(p.packageSn,parcel);
  }
 }
 return parcels.size===packages.length&&new Set(packages).size===packages.length?packages.map(p=>parcels.get(p)):null;
}
export function temuLabelFailure(reason){
 const text=String(reason||'motif non communiqué');
 if(/shipping address contains non-English characters/i.test(text))return 'TEMU · Étiquette refusée : adresse avec caractères non pris en charge par le service d’expédition. Correction de l’adresse dans TEMU requise ; aucun rachat automatique.';
 return 'TEMU · Étiquette refusée : '+text.slice(0,250);
}
