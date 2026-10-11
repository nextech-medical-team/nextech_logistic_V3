// Masking means the field was not disclosed; it is never a replacement address.
export function isMaskedAddressValue(value){return typeof value==='string'&&/[*•●]{3,}/u.test(value);}
export function maskedTemuAddressFields(shipping){
 const map={name:['receiptName','receiptAdditionalName'],street:['addressLine1','addressLine2','addressLine3'],postal:['postCode'],city:['regionName3'],country:['regionName1']};
 return Object.entries(map).filter(([,keys])=>keys.some(k=>isMaskedAddressValue(shipping?.[k]))).map(([field])=>field).filter(k=>k!=='country');
}
export function usableFrozenAddress(address){return ['name','street','postal','city','country'].every(k=>typeof address?.[k]==='string'&&address[k].trim()&&!isMaskedAddressValue(address[k]));}
