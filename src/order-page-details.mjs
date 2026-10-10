import {attachEquivalentDiagnostics} from './equivalent-diagnostics.mjs';
export async function orderPageDetails(db,rows){
 if(!rows.length)return;
 const choices=new Map((await db.query('SELECT id,transport_choice FROM orders WHERE id=ANY($1::text[])',[rows.map(r=>r.id)])).rows.map(r=>[r.id,r.transport_choice]));for(const row of rows)row.transport_choice=choices.get(row.id)||null;
 await attachEquivalentDiagnostics(db,rows);
 for(const row of rows)row.external_shipments=Array.isArray(row.source_payload?.historicalShipments)?row.source_payload.historicalShipments:[];
 const extras=(await db.query('SELECT order_id,id,carrier,environment,parcel_index,parcel_total,status,tracking,error FROM extra_parcels WHERE order_id=ANY($1::text[]) ORDER BY created_at,id',[rows.map(r=>r.id)])).rows;
 const byOrder=new Map();for(const {order_id,...item} of extras){const list=byOrder.get(order_id)||[];list.push(item);byOrder.set(order_id,list);}for(const row of rows)row.extra_parcels=byOrder.get(row.id)||[];
 const refs=rows.filter(r=>r.channel==='temu').map(r=>r.reference);if(!refs.length)return;
 const jobs=new Map((await db.query('SELECT reference,status,error,result,plan FROM temu_label_jobs WHERE reference=ANY($1::text[])',[refs])).rows.map(({reference,...job})=>[reference,job]));
 const docs=(await db.query("SELECT d.reference,d.package FROM temu_label_documents d JOIN temu_label_jobs j ON j.reference=d.reference WHERE d.reference=ANY($1::text[]) AND j.result->>'source'='temu_direct' AND j.packages ? d.package ORDER BY d.package",[refs])).rows;
 const byReference=new Map();for(const {reference,...item} of docs){const list=byReference.get(reference)||[];list.push(item);byReference.set(reference,list);}for(const row of rows)if(row.channel==='temu'){row.temu_job=jobs.get(row.reference)||null;row.temu_documents=byReference.get(row.reference)||[];}
}
