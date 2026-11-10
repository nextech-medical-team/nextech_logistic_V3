const clean=value=>String(value??'').trim().toUpperCase();
const departments=new Set([...Array.from({length:95},(_,i)=>String(i+1).padStart(2,'0')).filter(d=>d!=='20'),'2A','2B','971','972','973','974','975','976','977','978','984','986','987','988']);
export function departmentCode(value){const s=clean(value);return departments.has(s)?s:null;}
export function departmentFromPostal(value,country='FR'){
 if(clean(country)!=='FR')return null;
 const postal=clean(value).replace(/\s/g,'');if(!/^\d{5}$/.test(postal))return null;
 if(postal.startsWith('20'))return Number(postal)<20200?'2A':'2B';
 return departmentCode(/^(97|98)/.test(postal)?postal.slice(0,3):postal.slice(0,2));
}
export function amazonDestination(order){
 const address=order.erp_live?.bl?.shipping_address;
 // A BL address, when present, is authoritative even if it is incomplete.
 return address?{postal:address.postal_code,country:Object.hasOwn(address,'country')?address.country:order.address?.country,source:'bl'}:{postal:order.address?.postal,country:order.address?.country,source:'order'};
}
export function validateAmazonDelivery(config){
 const excluded=config.gofoExcludedDepartments??[];
 if(!Array.isArray(excluded)||excluded.length>110||excluded.some(d=>!departmentCode(d)))throw Error('Départements exclus GOFO invalides : utiliser 01 à 95, 2A/2B ou un département ultramarin reconnu.');
 const origins=config.amazonDeliveryOrigins??{};
 if(!origins||typeof origins!=='object'||Array.isArray(origins))throw Error('Entrepôts de départ Amazon invalides');
 const normalizedOrigins={};for(const carrier of ['gofo','gls']){const postal=clean(origins[carrier]);if(postal&&!/^\d{5}$/.test(postal))throw Error('Code postal de départ '+carrier.toUpperCase()+' : cinq chiffres requis');normalizedOrigins[carrier]=postal;}
 const rules=config.amazonDeliveryRules??[];
 if(!Array.isArray(rules)||rules.length>2200)throw Error('Grille des délais Amazon invalide');
 const seen=new Set(),normalizedRules=rules.map(r=>{
  if(!r||!['gls','gofo'].includes(r.carrier)||!/^\d{5}$/.test(clean(r.originPostal))||!departmentCode(r.department)||!Number.isInteger(Number(r.workDays))||Number(r.workDays)<1||Number(r.workDays)>10)throw Error('Chaque délai exige un transporteur, un départ à cinq chiffres, un département reconnu et 1 à 10 jours ouvrés.');
  const rule={carrier:r.carrier,originPostal:clean(r.originPostal),department:departmentCode(r.department),workDays:Number(r.workDays)},key=JSON.stringify([rule.carrier,rule.originPostal,rule.department]);
  if(seen.has(key))throw Error('Délai dupliqué pour '+rule.carrier.toUpperCase()+' / '+rule.originPostal+' / '+rule.department);seen.add(key);return rule;
 });
 return {gofoExcludedDepartments:[...new Set(excluded.map(departmentCode))].sort(),amazonDeliveryOrigins:normalizedOrigins,amazonDeliveryRules:normalizedRules};
}
export function applyAmazonDepartment(route,{channel,postal,country},config){
 if(channel!=='amazon'||route.carrier!=='gofo')return route;
 const department=departmentFromPostal(postal,country);
 if(!department||!(config.gofoExcludedDepartments||[]).includes(department))return route;
 return {...route,carrier:'gls',parcels:Math.ceil(route.weight/config.maxParcelKg),gofoDepartmentExclusion:{department,postal:String(postal),previousCarrier:'gofo'}};
}
export function amazonDeliveryEstimate(order,config){
 if(order.channel!=='amazon')return null;
 const destination=amazonDestination(order),department=departmentFromPostal(destination.postal,destination.country),carrier=order.carrier;
 const base={carrier,department,postal:destination.postal||'',destinationSource:destination.source,source:'configured_grid',estimated:true};
 if(order.partial_mode)return {...base,state:'partial_deliveries',workDays:null};
 if(!department||!['gls','gofo'].includes(carrier))return {...base,state:'unavailable',workDays:null};
 const originPostal=config.amazonDeliveryOrigins?.[carrier]||'';
 const matches=(config.amazonDeliveryRules||[]).filter(r=>r.carrier===carrier&&r.originPostal===originPostal&&r.department===department);
 if(matches.length!==1)return {...base,originPostal,state:'unconfigured',workDays:null};
 const days=matches[0].workDays;if(!Number.isInteger(days)||days<1||days>10)return {...base,originPostal,state:'unconfigured',workDays:null};
 return {...base,originPostal,state:'configured',workDays:days};
}
