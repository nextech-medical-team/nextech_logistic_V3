import {completeOrderDocumentsSql} from './complete-order-documents.mjs';
import {labelAttachment} from './label-attachment.mjs';
import {saveMapping} from './mapping-store.mjs';
import {currentParcelPdf} from './parcel-pdf.mjs';
import {queueLabelBatchFromBl} from './direct-label.mjs';
import ExcelJS from 'exceljs';
export async function workspaceApi({p,url,req,res,db,user,body,json,permitted,audit,carrierConfigured,catalog}){
 const operations=['admin','manager','operator'];
 if(p==='/api/labels/history'&&req.method==='GET'){
  const rows=(await db.query("SELECT h.id,h.archived_at,h.job->>'environment' environment,h.job->>'status' status,h.job->'tracking' tracking,(SELECT count(*)::int FROM carrier_label_history_documents d WHERE d.history_id=h.id) documents FROM carrier_label_history h WHERE order_id=$1 ORDER BY archived_at DESC",[url.searchParams.get('id')])).rows;json(res,200,{rows});return true;
 }
 if(p.startsWith('/api/labels/history/')&&req.method==='GET'){
  const parts=p.split('/'),id=parts[4],index=Number(parts[5]);if(!Number.isInteger(index)||index<0)throw Error('Document invalide');const row=(await db.query('SELECT pdf FROM carrier_label_history_documents WHERE history_id=$1 AND document_index=$2',[id,index])).rows[0];if(!row)throw Error('Ancienne étiquette introuvable');res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');await labelAttachment(db,res,'history',id,index+1);res.end(Buffer.from(row.pdf));return true;
 }
 if(p==='/api/orders/address'&&req.method==='POST'){
  permitted(user,operations);const b=await body(req),a={};for(const k of ['name','street','postal','city','country','phone','email'])a[k]=String(b.address?.[k]||'').trim().slice(0,250);
  a.country=a.country.toUpperCase();if(!a.name||!a.street||!a.postal||!a.city||! /^[A-Z]{2}$/.test(a.country))throw new Error('Nom, adresse, ville, code postal et pays à deux lettres requis');
  await db.transaction(async tx=>{
   const o=(await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(!o)throw new Error('Commande introuvable');
   if((await tx.query('SELECT order_id FROM carrier_jobs WHERE order_id=$1',[b.id])).rows.length)throw new Error('Une demande transporteur existe déjà : adresse figée pour éviter une divergence avec l’étiquette');
   await tx.query("UPDATE orders SET address=$2,recipient=$3,label_status='pending',issue=null WHERE id=$1",[b.id,JSON.stringify(a),a.name]);
   await tx.query("UPDATE jobs SET status='pending',available_at=now() WHERE order_id=$1 AND kind='label'",[b.id]);
  });await audit(user,'order.address.updated',{id:b.id});catalog?.start().catch(()=>{});json(res,200,{ok:true});return true;
 }
 if(p==='/api/mappings/export'&&req.method==='GET'){
  const rows=(await db.query('SELECT * FROM mappings ORDER BY channel,source_sku')).rows;
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Mapping SKU');
  sheet.addRow(['Gestionnaire','SKU Gestionnaire','SKU Erplain','Quantité Gestionnaire','Quantité Erplain','Notes']);
  for(const r of rows.filter(x=>!['tender','samples'].includes(x.channel)))sheet.addRow([({amazon:'Amazon',shopify:'Shopify',temu:'TEMU',rakuten:'Rakuten'})[r.channel]||r.channel,r.source_sku,r.target_sku,Number(r.source_qty),Number(r.target_qty),r.notes]);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="sku-mappings-v3.xlsx"');res.end(Buffer.from(await book.xlsx.writeBuffer()));return true;
 }
 if(p==='/api/carriers/labels'&&req.method==='POST'){
  permitted(user,operations);if(!carrierConfigured)throw new Error('Accès transporteurs production non configurés');const b=await body(req);const result=await queueLabelBatchFromBl(db,b.ids,user);await audit(user,'labels.production.requested',{queued:result.queued,skipped:result.skipped});json(res,202,result);return true;
 }
 if(p==='/api/carriers/status'&&req.method==='GET'){
  const values=name=>url.searchParams.getAll(name).filter(Boolean),q='%'+(url.searchParams.get('search')||'').slice(0,100)+'%';
  const page=Math.max(1,Number(url.searchParams.get('page'))||1);
  const where="WHERE (cardinality($1::text[])=0 OR (CASE WHEN o.carrier LIKE 'gls%' THEN 'gls' ELSE o.carrier END)=ANY($1::text[])) AND (cardinality($2::text[])=0 OR c.status=ANY($2::text[])) AND (o.reference ILIKE $3 OR o.recipient ILIKE $3 OR c.tracking::text ILIKE $3)";
  const args=[values('carrier'),values('status'),q];
  const sort=({reference:'o.reference',date:'c.updated_at',recipient:'o.recipient',city:"o.address->>'city'",carrier:'o.carrier',status:'c.status',tracking:'c.tracking::text',weight:'o.weight_kg'})[url.searchParams.get('sort')]||'c.updated_at';const direction=url.searchParams.get('direction')==='asc'?'ASC':'DESC';
  const rows=(await db.query(`SELECT c.order_id,o.reference,o.recipient,o.channel,o.carrier,o.address,o.weight_kg,o.parcel_count,o.erp_status,o.tracking_status,c.status,c.reference AS carrier_reference,c.tracking,c.error,c.attempts,c.updated_at,(SELECT count(*)::int FROM carrier_documents d WHERE d.order_id=o.id) AS documents FROM carrier_jobs c JOIN orders o ON o.id=c.order_id ${where} ORDER BY ${sort} ${direction},o.id LIMIT 100 OFFSET $4`,[...args,(page-1)*100])).rows;
  const total=Number((await db.query(`SELECT count(*) n FROM carrier_jobs c JOIN orders o ON o.id=c.order_id ${where}`,args)).rows[0].n);
  json(res,200,{configured:carrierConfigured,rows,total,page,pages:Math.max(1,Math.ceil(total/100))});return true;
 }
 const doc=p.match(/^\/api\/carriers\/documents\/([^/]+)\/(\d+)$/);
 if(doc&&req.method==='GET'){
  const row=(await db.query("SELECT d.pdf FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND d.document_index=$2 AND c.status<>'superseded'",[decodeURIComponent(doc[1]),Number(doc[2])])).rows[0];
  if(!row){json(res,404,{error:'PDF indisponible'});return true;}res.setHeader('Content-Type','application/pdf');await labelAttachment(db,res,'order',decodeURIComponent(doc[1]),Number(doc[2])+1);res.end(await currentParcelPdf(db,row.pdf,decodeURIComponent(doc[1]),Number(doc[2])));return true;
 }
 if(p==='/api/order-detail'&&req.method==='GET'){
  const id=url.searchParams.get('id');const order=(await db.query('SELECT orders.*, '+completeOrderDocumentsSql+' AS complete_order_documents FROM orders WHERE id=$1',[id])).rows[0];if(!order)throw new Error('Commande introuvable');
  const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line',[id])).rows;
  const jobs=(await db.query('SELECT kind,status,attempts,error,available_at FROM jobs WHERE order_id=$1',[id])).rows;
  const carrierJob=(await db.query('SELECT status,environment,tracking FROM carrier_jobs WHERE order_id=$1',[id])).rows[0];json(res,200,{order,lines,jobs,carrierJob});return true;
 }
 if(p==='/api/orders/export'&&req.method==='POST'){
  const {ids}=await body(req);if(!Array.isArray(ids)||!ids.length||ids.length>200)throw new Error('Sélectionner de 1 à 200 commandes');
  const rows=(await db.query('SELECT o.reference,o.channel,o.recipient,o.address,o.source_date,o.weight_kg,o.parcel_count,o.carrier,o.label_status,o.erp_status,o.tracking_status,o.issue,l.source_sku,coalesce(l.target_sku,m.target_sku,CASE WHEN o.channel IN (\'tender\',\'samples\') THEN l.source_sku END) target_sku,l.quantity,coalesce(l.target_quantity,CASE WHEN o.channel IN (\'tender\',\'samples\') THEN l.quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) END) target_quantity,l.source_payload AS line_source FROM orders o LEFT JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE o.id=ANY($1::text[]) ORDER BY array_position($1::text[],o.id),l.source_line',[ids])).rows;
  json(res,200,{rows});return true;
 }
 if(p==='/api/mappings/save'&&req.method==='POST'){
  permitted(user,['admin','manager']);const b=await body(req);
  const saved=await saveMapping(db,b);
  await audit(user,'mapping.saved',{channel:b.channel,sku:b.source_sku});catalog?.start().catch(()=>{});json(res,200,{ok:true});return true;
 }
 if(p==='/api/mappings/delete'&&req.method==='POST'){
  permitted(user,['admin','manager']);const b=await body(req);await db.query('DELETE FROM mappings WHERE channel=$1 AND source_sku=$2',[b.channel,b.source_sku]);await audit(user,'mapping.deleted',{channel:b.channel,sku:b.source_sku});json(res,200,{ok:true});return true;
 }
 if(p==='/api/technical'&&req.method==='GET'){
  permitted(user,['admin','manager']);json(res,200,{jobs:(await db.query('SELECT kind,status,count(*)::int AS count FROM jobs GROUP BY kind,status ORDER BY kind,status')).rows,carriers:(await db.query('SELECT carrier,status,count(*)::int AS count FROM carrier_jobs GROUP BY carrier,status ORDER BY carrier,status')).rows});return true;
 }
 return false;
}
