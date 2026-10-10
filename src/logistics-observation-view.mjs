import {aggregateParcels} from './status-policy.mjs';
export function logisticsObservation(targets,{now=Date.now(),maxAgeMs=8*3600000}={}){
 const parcels=targets.map(t=>{
  const at=Date.parse(t.checkedAt),fresh=Number.isFinite(at)&&at<=now&&now-at<=maxAgeMs;
  const events=Array.isArray(t.events)?t.events.filter(e=>String(e.tracking)===String(t.tracking)&&e.carrier===t.carrier):[];
  return {tracking:t.tracking,carrier:t.carrier,checkedAt:t.checkedAt||null,status:fresh&&!t.error?aggregateParcels([t.tracking],events).status:'unknown',error:t.error||(!fresh?'Lecture de suivi absente ou périmée':null)};
 });
 const statuses=parcels.map(p=>p.status);
 const status=!parcels.length?'unknown':statuses.every(s=>s==='delivered')?'delivered':statuses.includes('exception')?'exception':statuses.includes('cancelled')?'cancelled':statuses.includes('unknown')?'unknown':statuses.some(s=>s==='shipped'||s==='delivered')?'shipped':'not_shipped';
 return {status,parcels,source:'parcel_api',maxAgeMs};
}
export async function attachLogisticsObservations(db,rows){
 if(!rows.length)return;
 const ids=rows.map(r=>r.id);
 const targets=(await db.query(`WITH targets AS (
 SELECT order_id,carrier,environment,jsonb_array_elements_text(tracking) tracking FROM carrier_jobs WHERE order_id=ANY($1::text[]) AND status='ready'
 UNION SELECT order_id,carrier,environment,tracking FROM extra_parcels WHERE order_id=ANY($1::text[]) AND status='ready'
 UNION SELECT order_id,carrier,environment,jsonb_array_elements_text(tracking) tracking FROM partial_deliveries WHERE order_id=ANY($1::text[]) AND status='ready'
 ) SELECT t.order_id,t.tracking,CASE WHEN t.carrier LIKE 'gls%' THEN 'gls' ELSE t.carrier END carrier,c.checked_at AS "checkedAt",c.events,c.error
 FROM targets t LEFT JOIN carrier_tracking c ON c.carrier=CASE WHEN t.carrier LIKE 'gls%' THEN 'gls' ELSE t.carrier END AND c.environment=t.environment AND c.tracking=t.tracking`,[ids])).rows;
 for(const row of rows){
  let own=targets.filter(t=>t.order_id===row.id);
  if(row.channel==='temu'&&!row.transport_choice&&!row.partial_mode){
   const r=row.temu_job?.result||{},events=(r.deliveryStatuses||[]).filter(e=>e.source==='temu_tracking').map(e=>({carrier:'temu',tracking:e.trackingKey,code:e.code,label:e.label,at:e.at}));
   own=(r.packageInfoResultList||[]).filter(p=>p.trackingNumber).map(p=>({tracking:p.trackingNumber,carrier:'temu',checkedAt:r.trackingVerifiedAt,events,error:(r.trackingErrors||[]).find(e=>e.package===p.packageSn)?.error}));
  }
  row.logistics_observation=logisticsObservation(own);
 }
}
