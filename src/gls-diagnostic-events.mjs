import {carrierState} from './status-policy.mjs';

// Observed Track & Trace pairs, interpreted only for a read-only diagnostic.
// Keep original events and never infer delivery from an expected delivery scan.
const physicalScans=new Map([
 ['INBOUD.NORMAL','The parcel has reached the parcel center'],
 ['INTIAL.NORMAL','The parcel was handed over to GLS'],
 ['OUTDEL.NORMAL','The parcel is expected to be delivered during the day'],
]);
export function glsDiagnosticEvent(event){
 if(event.carrier!=='gls'||carrierState('gls',event)!=='unknown')return event;
 const code=String(event.code??'').trim().toUpperCase();
 const label=String(event.label??'').trim().replace(/[.!]+$/,'');
 if(physicalScans.get(code)?.toLowerCase()!==label.toLowerCase())return event;
 return {...event,code:'INTRANSIT'};
}
