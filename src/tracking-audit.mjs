import {assertLabelStockGate} from './label-stock-gate.mjs';
export async function trackingAudit(db){
 const orders=(await db.query(`SELECT id,reference,channel,archived,simulation,partial_mode,label_status,tracking_status,invoice_status,carrier,issue,erp_live FROM orders ORDER BY reference`)).rows;
 const carriers=(await db.query('SELECT order_id,carrier,environment,status,tracking,error FROM carrier_jobs')).rows;
 const extra=(await db.query('SELECT order_id,carrier,environment,status,tracking,error FROM extra_parcels')).rows;
 const partials=(await db.query('SELECT id,order_id,status,carrier,tracking,bl,error FROM partial_deliveries')).rows;
 const tracking=(await db.query('SELECT * FROM carrier_tracking')).rows;
 const lifecycle=(await db.query('SELECT * FROM document_lifecycle')).rows;
 const temu=(await db.query("SELECT reference,status,error,result->'deliveryStatuses' AS events,result->'packageInfoResultList' AS packages FROM temu_label_jobs")).rows;
 const preparation=[];for(const o of (await db.query('SELECT * FROM orders WHERE archived=false AND partial_mode=false')).rows){if(!o.erp_live?.bl?.id)continue;try{await assertLabelStockGate(db,o);preparation.push({id:o.id,valid:true});}catch(e){preparation.push({id:o.id,valid:false,error:e.message});}}
 return {at:new Date().toISOString(),orders,carriers,extra,partials,tracking,lifecycle,temu,preparation};
}
