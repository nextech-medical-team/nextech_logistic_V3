// Business rules approved on 2026-10-04. Pure policy: no API or database calls.
const text=value=>String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[.!]+$/,'');
export const BL_STATUSES=new Set(['unpublished','pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','cancelled']);
export function carrierState(carrier,{code,label}={}){
 const c=String(code??'').trim().toUpperCase(),l=text(label);
 // Negative evidence always wins over positive words or ambiguous carrier codes.
 if(['CANCELLED','CANCELED'].includes(c)||/\b(cancelled|canceled|annule)\b/.test(l))return 'cancelled';
 if(['NOTDELIVERED','NOT_DELIVERED'].includes(c)||/\b(not delivered|undelivered|unsigned|non livre|pas livre|delivery failed|delivery unsuccessful|refused|refuse|returned to sender|retour expediteur)\b/.test(l))return 'exception';
 // Exact GLS non-delivery and stored scan pairs preserve the incident.
 if(carrier==='gls'&&new Map([['WHOUSE.NORMAL','the parcel is stored in the parcel center'],['NOTDEL.WRONGADDRES','the parcel could not be delivered as further address information is needed'],['NOTDEL.ACCCTRLSYS','the parcel could not be delivered because an access code is required for the door']]).get(c)===l)return 'exception';
 // TEMU textual event codes describe physical scans; never reuse carrier numeric codes.
 if(carrier==='temu'){
  if(['DELIVERED','DELIVERY COMPLETED'].includes(c))return 'delivered';
  if(['IN TRANSIT','INTRANSIT','LAST MILE CARRIER PICKED UP','ARRIVED AT POST OFFICE','OUT FOR DELIVERY'].includes(c))return 'shipped';
  if(['LAST-MILE MANIFEST','LABEL CREATED','SHIPMENT INFORMATION RECEIVED'].includes(c))return 'not_shipped';
  if(/^(picked up|on the way|arrived at fedex hub|departed fedex hub)$/.test(l))return 'shipped';
 }
 if(carrier==='gls'&&(['DELIVERED','DELIVEREDPS','FINAL'].includes(c)||/^DELIVD/.test(c)))return 'delivered';
 if(/^(delivered|delivered successfully|delivery completed|livre|colis livre|votre colis est livre|le colis a ete livre)$/.test(l)||/^delivered by\s+\S/.test(l))return 'delivered';
 if(carrier==='gofo'&&(/^(signed|signed for|proof of delivery)$/.test(l)||/^received by\s+\S/.test(l)))return 'delivered';
 // Exact physical GLS scan pairs already qualified by the read-only diagnostic.
 if(carrier==='gls'&&new Map([['INBOUD.PARCELSHOP','the parcel has reached the parcelshop'],['OUTBOD.NORMAL','the parcel has left the parcel center'],['INBOUD.NORMAL','the parcel has reached the parcel center'],['INTIAL.NORMAL','the parcel was handed over to gls'],['OUTDEL.NORMAL','the parcel is expected to be delivered during the day']]).get(c)===l)return 'shipped';
 const transit=new Set(['INTRANSIT','IN_DELIVERY','INDELIVERY','HUB','INWAREHOUSE','DELIVERY_DEPOT']);
 if((carrier==='gls'&&transit.has(c))||(carrier==='gofo'&&['201','204'].includes(c)))return 'shipped';
 if(/^(in transit|en transit|en cours|out for delivery|en cours de livraison|livraison en cours|arrive au depot|sorti du depot|sortie du depot|arrived at sorting cent(?:er|re)|arrived at gofo regional destination facility|back to the sorting center)$/.test(l)||/^(the (?:package|parcel) (?:has )?)?(?:left sorting cent(?:er|re)|arrived at sorting cent(?:er|re))$/.test(l)||/^the driver is out for delivery\b/.test(l)||/^(le chauffeur est en train de livrer|le chauffeur est en route pour la livraison|votre colis est en transit sur nos plateformes logistiques|(?:votre )?colis (?:est )?en cours d['’]acheminement|the package is in transit)$/.test(l))return 'shipped';
 if((carrier==='gls'&&['DATA_RECEIVED','PREADVICE','INTIAL.PREADVICE','PLANNEDPICKUP','INPICKUP','NOTPICKEDUP'].includes(c))||(carrier==='gofo'&&c==='100')||/^(data received|donnees recues|label created|etiquette creee)$/.test(l))return 'not_shipped';
 return 'unknown';
}
export function aggregateParcels(expectedTracking,events){
 const expected=expectedTracking.map(String);if(!expected.length||new Set(expected).size!==expected.length)return {status:'unknown',complete:false,reason:'Liste des colis absente ou ambiguë'};
 const states=expected.map(tracking=>{
  const rows=events.filter(e=>String(e.tracking)===tracking);
  if(!rows.length||rows.some(e=>!Number.isFinite(Date.parse(e.at))))return 'unknown';
  rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));const latest=rows.filter(e=>Date.parse(e.at)===Date.parse(rows[0].at));
  // A confirmed destination ParcelShop deposit is delivery (user rule).
  // Later arrival scans at that shop do not undo it; any intervening other event blocks this rule.
  const relayArrival=e=>e.carrier==='gls'&&String(e.code).trim().toUpperCase()==='INBOUD.PARCELSHOP'&&text(e.label)==='the parcel has reached the parcelshop';
  const relayDeposit=e=>e.carrier==='gls'&&String(e.code).trim().toUpperCase()==='DELIVD.PARCELSHOP'&&text(e.label)==='the parcel has been delivered at the parcelshop (see parcelshop information)';
  if(latest.every(e=>relayArrival(e)||relayDeposit(e))&&(latest.some(relayDeposit)||relayDeposit(rows.find(e=>!relayArrival(e))||{})))return 'delivered';
  const values=new Set(latest.map(e=>carrierState(e.carrier,e)));return values.size===1?[...values][0]:'unknown';
 });
 const complete=states.every(s=>s!=='unknown');
 // Cancellation is not removed from the denominator: it needs reconciliation.
 return {status:states.every(s=>s==='delivered')?'delivered':states.some(s=>s==='shipped'||s==='delivered')?'shipped':states.includes('exception')?'exception':states.includes('cancelled')?'cancelled':states.includes('unknown')?'unknown':'not_shipped',complete,states};
}
export function shippingTransition({current,target,readyConsumed=false,preparationComplete=false,cancellationConfirmed=false}){
 if(!BL_STATUSES.has(current))throw Error('Erplain · Statut BL inconnu');
 if(!['ready_to_ship','shipped','delivered','cancelled'].includes(target))throw Error('Erplain · Modification du statut intermédiaire interdite');
 if(current===target)return {write:false,reason:'already_applied'};
 if(current==='cancelled')return {write:false,reason:'cancelled_terminal'};
 if(target==='cancelled'){
  if(!cancellationConfirmed)throw Error('Annulation commerciale non confirmée');
  return {write:true,reason:'confirmed_cancellation'};
 }
 if(current==='delivered')return {write:false,reason:'delivered_terminal'};
 if(target==='ready_to_ship')return {write:current==='pending'&&!readyConsumed&&preparationComplete,reason:'initial_preparation_only'};
 if(current==='unpublished')return {write:false,reason:'unpublished_document'};
 if(current==='shipped'&&target!=='delivered')return {write:false,reason:'no_regression'};
 return {write:true,reason:'physical_progress'};
}
export function automaticBilling(channel){return ['amazon','shopify','temu'].includes(channel);}
export function paymentAmount(invoice){
 const {total,paid_amount:paid,remaining_balance:remaining}=invoice;
 if([total,paid,remaining].some(v=>v==null||v===''||!Number.isFinite(Number(v))))throw Error('Erplain · Solde non vérifiable');
 if(Number(total)<0||Number(paid)<0||Number(remaining)<0||Math.abs(Number(total)-Number(paid)-Number(remaining))>0.011)throw Error('Erplain · Solde incohérent');
 return Number(remaining);
}
