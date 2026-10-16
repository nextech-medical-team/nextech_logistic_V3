import {attachLogisticsObservations} from './logistics-observation-view.mjs';
import {platformIndicativeView} from './platform-indicative-view.mjs';
import {attachEquivalentDiagnostics} from './equivalent-diagnostics.mjs';
import {attachSkuSubstitutions} from './sku-substitution-view.mjs';
import {hasCompletePartialDocuments} from './complete-order-documents.mjs';
import {visibleOrderBls} from './bl-identity.mjs';
// Diagnostic dependencies must be attached before classification. Display-only
// joins can wait until pagination; no cache or stale diagnostic snapshot is used.
export async function orderPageDetails(db,rows,mode='all'){
 if(!rows.length)return;
 if(!['all','diagnostics','display'].includes(mode))throw Error('Invalid order details mode');
 if(mode!=='display'){
 for(const row of rows)row.platform_status=platformIndicativeView(row);
 const partialBls=(await db.query('SELECT order_id,bl,status,environment,(SELECT count(*)::int FROM partial_documents p WHERE p.delivery_id=partial_deliveries.id) documents FROM partial_deliveries WHERE order_id=ANY($1::text[]) ORDER BY created_at,id',[rows.map(r=>r.id)])).rows;
 const byBl=new Map();for(const d of partialBls){if(d.bl?.id){const list=byBl.get(d.order_id)||[];list.push(d.bl);byBl.set(d.order_id,list);}}
 for(const row of rows)row.erplain_tracking_bls=visibleOrderBls(row,byBl.get(row.id)||[]);
 const byPartial=new Map();for(const d of partialBls){const list=byPartial.get(d.order_id)||[];list.push({bl:{id:d.bl?.id,status:d.bl?.status},status:d.status,environment:d.environment,documents:d.documents});byPartial.set(d.order_id,list);}
 for(const row of rows)if(row.partial_mode){row.partial_document_status=byPartial.get(row.id)||[];row.complete_order_documents=hasCompletePartialDocuments(row);}
 const choices=new Map((await db.query('SELECT id,transport_choice FROM orders WHERE id=ANY($1::text[])',[rows.map(r=>r.id)])).rows.map(r=>[r.id,r.transport_choice]));for(const row of rows)row.transport_choice=choices.get(row.id)||null;
 await attachEquivalentDiagnostics(db,rows);
 for(const row of rows)row.external_shipments=Array.isArray(row.source_payload?.historicalShipments)?row.source_payload.historicalShipments:[];
 const refs=rows.filter(r=>r.channel==='temu').map(r=>r.reference);if(refs.length){
 const jobs=new Map((await db.query("SELECT reference,status,error,result,plan,to_jsonb(temu_label_jobs)->>'state_since' AS state_since,to_jsonb(temu_label_jobs)->>'updated_at' AS updated_at FROM temu_label_jobs WHERE reference=ANY($1::text[])",[refs])).rows.map(({reference,...job})=>[reference,job]));
 const docs=(await db.query("SELECT d.reference,d.package FROM temu_label_documents d JOIN temu_label_jobs j ON j.reference=d.reference WHERE d.reference=ANY($1::text[]) AND j.packages ? d.package ORDER BY d.package",[refs])).rows;
 const byReference=new Map();for(const {reference,...item} of docs){const list=byReference.get(reference)||[];list.push(item);byReference.set(reference,list);}for(const row of rows)if(row.channel==='temu'){row.temu_job=jobs.get(row.reference)||null;row.temu_documents=byReference.get(row.reference)||[];}
 }
 }
 if(mode!=='diagnostics'){
  await attachSkuSubstitutions(db,rows);
  const extras=(await db.query('SELECT order_id,id,carrier,environment,parcel_index,parcel_total,status,tracking,error FROM extra_parcels WHERE order_id=ANY($1::text[]) ORDER BY created_at,id',[rows.map(r=>r.id)])).rows;
  const byOrder=new Map();for(const {order_id,...item} of extras){const list=byOrder.get(order_id)||[];list.push(item);byOrder.set(order_id,list);}for(const row of rows)row.extra_parcels=byOrder.get(row.id)||[];
  await attachLogisticsObservations(db,rows);
 }
}
