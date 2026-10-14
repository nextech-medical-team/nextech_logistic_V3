import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {erplainAccount} from './erplain-accounts.mjs';
import {erplainFetch} from './erplain-transport.mjs';
import {currentParcelPdf} from './parcel-pdf.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';
import {currentPartialSkuPdf} from './label-sku-copy.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

export async function initializeReceiptWarehouse(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS receipt_warehouse_exports(id text PRIMARY KEY,run_id text NOT NULL REFERENCES receipt_recovery_runs(id),scope jsonb NOT NULL,scope_hash text NOT NULL,state text NOT NULL DEFAULT 'queued',stage text,error text,observations jsonb DEFAULT '[]',provider_job text,bl_pdf bytea,label_pdf bytea,created_by text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(run_id,scope_hash));`);
}
export async function receiptLabelCopy(bytes,render){
 try{return {pdf:await render(),observation:null};}
 catch(e){const pdf=await PDFDocument.load(bytes);if(!pdf.getPageCount())throw Error('Étiquette archivée sans page');return {pdf:Buffer.from(bytes),observation:'PDF transporteur conservé ; enrichissement indisponible : '+String(e.message).slice(0,200)};}
}
export async function combineReceiptPdfs(documents){
 if(!documents.length)throw Error('Aucun PDF disponible');
 if(documents.reduce((n,b)=>n+b.length,0)>80*1024*1024)throw Error('Lot PDF trop volumineux');
 const output=await PDFDocument.create();
 for(const bytes of documents){const input=await PDFDocument.load(bytes);if(!input.getPageCount())throw Error('PDF sans page');for(const p of await output.copyPages(input,input.getPageIndices()))output.addPage(p);}
 return Buffer.from(await output.save());
}
export function receiptWarehouseExports(db,directory,{fetchImpl=fetch,api=erplainAccount(directory,'live',{fetchImpl:(url,options)=>fetchImpl(url,{...options,headers:{...options.headers,'Erplain-From-Frontend':'true'}})}),pdfFetch=null,buildLabels=null}={}){
 async function labels(scope){
  const documents=[],packages=new Set(),observations=[];
  async function append(bytes,render,reference){const copy=await receiptLabelCopy(bytes,render);documents.push(copy.pdf);if(copy.observation)observations.push(reference+' : '+copy.observation);}
  for(const item of scope){
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[item.id])).rows[0];if(!o)throw Error('Commande introuvable : '+item.reference);
   let count=0;
   if(item.deliveryIds?.length){
    for(const d of (await db.query("SELECT d.pdf,d.delivery_id,d.document_index FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 AND p.id=ANY($2::text[]) AND p.status NOT IN ('cancelled','review') ORDER BY p.created_at,p.id,d.document_index",[o.id,item.deliveryIds])).rows){count++;await append(d.pdf,()=>currentPartialSkuPdf(db,d.pdf,d.delivery_id,d.document_index),o.reference);}
   }else if(o.channel==='temu'){
    for(const d of (await db.query('SELECT pdf,package FROM temu_label_documents WHERE reference=$1 ORDER BY package',[o.reference])).rows){count++;if(packages.has(d.package))continue;packages.add(d.package);await append(d.pdf,()=>currentTemuPdf(db,d.pdf,o.reference,d.package),o.reference);}
   }else{
    for(const d of (await db.query("SELECT d.pdf,d.document_index FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.status='ready' AND c.environment='production' ORDER BY d.document_index",[o.id])).rows){count++;await append(d.pdf,()=>currentParcelPdf(db,d.pdf,o.id,d.document_index),o.reference);}
   }
   if(!count)throw Error('Étiquette encore indisponible : '+o.reference+' ; aucun achat ni nouvelle expédition lancé par le téléchargement');
   for(const d of (await db.query("SELECT id,pdf FROM extra_parcels WHERE order_id=$1 AND status='ready' AND environment='production' AND pdf IS NOT NULL ORDER BY created_at,id",[o.id])).rows)await append(d.pdf,()=>currentParcelPdf(db,d.pdf,o.id,0,d.id),o.reference);
  }
  return {pdf:await combineReceiptPdfs(documents),observations};
 }
 async function start(runId,ids,user){
  if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw Error('Sélectionner de 1 à 100 commandes');
  const run=(await db.query('SELECT plan FROM receipt_recovery_runs WHERE id=$1',[runId])).rows[0];if(!run?.plan)throw Error('Analyse introuvable');
  const orders=(await db.query('SELECT id,reference,tracking_status,archived,partial_mode,erp_live FROM orders WHERE id=ANY($1::text[])',[ids])).rows;
  const scope=[];
  for(const id of ids){const row=run.plan.rows.find(r=>r.id===id),o=orders.find(o=>o.id===id);if(!row||!o)throw Error('Commande hors de cette réception');
   if(o.archived||['cancelled','shipped','in_transit','delivered','delivered_simulated'].includes(o.tracking_status))throw Error('Commande déjà terminée ou annulée : '+o.reference);
   if(o.partial_mode){
    const parts=(await db.query("SELECT p.id,p.bl FROM partial_deliveries p WHERE p.order_id=$1 AND p.status NOT IN ('cancelled','review') AND EXISTS(SELECT 1 FROM partial_documents d WHERE d.delivery_id=p.id) ORDER BY p.created_at,p.id",[id])).rows.filter(p=>p.bl?.id&&!['cancelled','shipped','delivered','completed'].includes((row.bls?.find(b=>String(b.id)===String(p.bl.id))||p.bl).status));
    if(!parts.length)throw Error('Aucun BL partiel avec PDF disponible : '+o.reference);
    scope.push({id,reference:o.reference,blId:String(parts[0].bl.id),blIds:parts.map(p=>String(p.bl.id)),deliveryIds:parts.map(p=>p.id)});continue;
   }
   const bl=row.bls?.find(b=>String(b.id)===String(o.erp_live?.bl?.id))||o.erp_live?.bl;
   if(!bl?.id||['cancelled','shipped','delivered','completed'].includes(bl.status)||['cancelled','shipped','delivered','completed'].includes(o.erp_live?.bl?.status))throw Error('BL absent, annulé ou déjà expédié : '+o.reference);
   scope.push({id,reference:o.reference,blId:String(bl.id),bl:bl.label});
  }
  scope.sort((a,b)=>Number(a.blId)-Number(b.blId)||a.id.localeCompare(b.id));
  const hash=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const id=randomUUID();
  const result=(await db.query(`INSERT INTO receipt_warehouse_exports(id,run_id,scope,scope_hash,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,scope_hash) DO UPDATE SET scope_hash=excluded.scope_hash RETURNING id`,[id,runId,JSON.stringify(scope),hash,user.email])).rows[0];
  return status(result.id);
 }
 async function status(id){const r=(await db.query('SELECT id,run_id,scope,state,stage,error,observations,updated_at,bl_pdf IS NOT NULL AS bl_ready,label_pdf IS NOT NULL AS labels_ready FROM receipt_warehouse_exports WHERE id=$1',[id])).rows[0];if(!r)throw Error('Export introuvable');if(r.state==='generating'&&Date.now()-Date.parse(r.updated_at)>10*60*1000){r.state='review';r.error='Export Erplain interrompu ou non confirmé : vérifier son résultat, sans nouvelle génération automatique.';}return r;}
 async function file(id){
  if(pdfFetch)return pdfFetch(id);
  const c=JSON.parse(await readFile(path.join(directory,'erplain-live.json'),'utf8'));
  if(c.url!=='https://api.erplain.app/graphql'||Number(c.companyId)!==100174)throw Error('Compte Erplain non vérifiable');
  let response=await erplainFetch(c,'https://api.erplain.app/file/'+encodeURIComponent(id),()=>({method:'GET',redirect:'manual',signal:AbortSignal.timeout(45000),headers:{authorization:'Bearer '+c.apiKey,'x-company-id':'100174','Erplain-From-Frontend':'true'}}),{readOnly:true,fetchImpl});
  if([301,302,303,307,308].includes(response.status)){const url=new URL(response.headers.get('location'));if(url.protocol!=='https:'||url.hostname!=='erplain-production-files.s3.eu-west-3.amazonaws.com')throw Error('Hôte PDF Erplain non autorisé');response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(45000)});}
  if(!response.ok)throw Error('PDF Erplain HTTP '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>80*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('PDF Erplain invalide');return bytes;
 }
 async function advance(){
  const pending=(await db.query("SELECT id FROM receipt_warehouse_exports WHERE state IN ('queued','waiting') ORDER BY created_at LIMIT 1")).rows[0];if(!pending)return;
  await withShipmentLock(async()=>{
   const job=(await db.query('SELECT * FROM receipt_warehouse_exports WHERE id=$1',[pending.id])).rows[0];if(!['queued','waiting'].includes(job.state))return;
   try{
    if(!job.label_pdf){const built=await (buildLabels?buildLabels(job.scope):labels(job.scope)),pdf=Buffer.isBuffer(built)?built:built.pdf;await db.query("UPDATE receipt_warehouse_exports SET label_pdf=$2,observations=$3,stage='Étiquettes combinées disponibles',updated_at=now() WHERE id=$1",[job.id,pdf,JSON.stringify(built.observations||[])]);}
    await api.verify();
    if(!job.provider_job){
     // Persist before POST. An interrupted/uncertain generation is never replayed.
     await db.query("UPDATE receipt_warehouse_exports SET state='generating',stage='Export des BL demandé à Erplain',updated_at=now() WHERE id=$1",[job.id]);
     const result=await api.request('mutation V3ReceiptWarehousePdfs($ids:[ID!]!){GenerateShippingOrdersPdfs(ids:$ids)}',{ids:[...new Set(job.scope.flatMap(o=>o.blIds||[o.blId]))]});
     const token=result?.GenerateShippingOrdersPdfs;if(typeof token!=='string'||!token)throw Error('Identifiant export Erplain absent : ne pas relancer la génération');
     await db.query("UPDATE receipt_warehouse_exports SET provider_job=$2,state='waiting',stage='Erplain prépare les BL combinés',updated_at=now() WHERE id=$1",[job.id,token]);return;
    }
    const result=(await api.request('query V3ReceiptWarehousePdfStatus($id:ID!){JobBatch(id:$id){id pending_jobs failed_jobs finished_at errors file{id mime}}}',{id:job.provider_job})).JobBatch;
    if(!result||String(result.id)!==job.provider_job)throw Error('Export Erplain non retrouvé');
    if(result.failed_jobs||result.errors)throw Error('Export Erplain en échec');
    if(!result.finished_at||!result.file)return;
    if(result.file.mime!=='application/pdf')throw Error('Le fichier Erplain reçu n’est pas un PDF');
    const pdf=await file(result.file.id);
    await db.query("UPDATE receipt_warehouse_exports SET bl_pdf=$2,state='complete',stage='BL et étiquettes combinés disponibles',error=null,updated_at=now() WHERE id=$1",[job.id,pdf]);
   }catch(e){await db.query("UPDATE receipt_warehouse_exports SET state='review',error=$2,updated_at=now() WHERE id=$1",[job.id,String(e.message).slice(0,450)]);}
  },['receipt-warehouse-export:'+pending.id]);
 }
 async function routes({p,req,res,url,user,body,json,permitted}){
  if(!p.startsWith('/api/receipts/recovery/warehouse'))return false;
  permitted(user,['admin','manager','operator']);
  if(p==='/api/receipts/recovery/warehouse'&&req.method==='POST'){permitted(user,['admin','manager']);const b=await body(req);json(res,202,await start(b.id,b.ids,user));return true;}
  if(p==='/api/receipts/recovery/warehouse/status'&&req.method==='GET'){json(res,200,await status(url.searchParams.get('id')));return true;}
  if(p==='/api/receipts/recovery/warehouse/pdf'&&req.method==='GET'){
   const kind=url.searchParams.get('kind');if(!['bl','labels'].includes(kind))throw Error('Type de PDF invalide');
   const r=(await db.query('SELECT bl_pdf,label_pdf FROM receipt_warehouse_exports WHERE id=$1',[url.searchParams.get('id')])).rows[0],pdf=kind==='bl'?r?.bl_pdf:r?.label_pdf;
   if(!pdf)throw Error('PDF encore indisponible');res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition','attachment; filename="reception-'+kind+'-combines.pdf"');res.end(pdf);return true;
  }
  return false;
 }
 return {start,status,advance,routes};
}
