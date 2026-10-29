// Published calculator, country tariffs confirmed there on 22/10/2026:
// https://calculateur-amazon-temu.nextech-medical.workers.dev/
// These tariffs are forecasts, never substitutes for a TEMU provider quote.
export const publishedFedexRates20261022=Object.freeze({DE:6.89,NL:6.34,BE:6.34,LU:6.34,IT:7.04,ES:5.49,PT:6.87,IE:12.95,DK:9.97,AT:8.58,PL:5.65,LT:7.92,LV:7.75,CZ:7.75,HU:7.75,SI:12.95,EE:7.75,SK:7.75,SE:12.95,RO:7.75,FI:14.85,BG:9.97,GR:7.75,CY:11.09});
export function calculatorServices(services=[]){
 // Upgrade only the old zoned snapshot. Already refreshed/custom country
 // services are retained; source arrays are never changed in place.
 if(!services.some(s=>/^FedEx Zone [1-4]$/.test(s[0])))return services;
 const modern=services.filter(s=>String(s[0]).startsWith('FedEx')&&!/^FedEx Zone [1-4]$/.test(s[0]));
 const covered=new Set(modern.flatMap(s=>String(s[1]).split(' ')));
 const out=services.flatMap(s=>{
  if(!/^FedEx Zone [1-4]$/.test(s[0]))return [s];
  const remaining=String(s[1]).split(' ').filter(code=>!Object.hasOwn(publishedFedexRates20261022,code));
  return remaining.length?[[s[0],remaining.join(' '),s[2],s[3]]]:[];
 });
 for(const [code,price] of Object.entries(publishedFedexRates20261022))if(!covered.has(code))out.push([`FedEx ${code} — tarif 22/10/2026`,code,25,[[0.01,price],[25,price]]]);
 return out;
}
