// User policy: standard destination VAT, preserving seller proceeds including tax.
// Verified 2026-10-14 against official tables (see docs/import-temu-excel.md).
export const temuDestinationRates=Object.freeze({AT:20,BE:21,BG:20,CY:19,CZ:21,DE:19,DK:25,EE:24,GR:24,ES:21,FI:25.5,FR:20,HR:25,HU:27,IE:23,IT:22,LT:21,LU:17,LV:21,MT:18,NL:21,PL:23,PT:23,RO:21,SE:25,SI:22,SK:23,GB:20,CH:8.1,NO:25});
export function temuDestinationVat(order){
 const raw=String(order.address?.country||order.source_payload?.country||'').trim().toUpperCase(),country=({EL:'GR',UK:'GB'})[raw]||raw;
 const rate=temuDestinationRates[country];
 if(rate===undefined)throw Error('TEMU · TVA du pays de livraison à configurer : '+(country||'pays absent'));
 return {country,rate,policy:'temu_destination_standard_20261014'};
}
