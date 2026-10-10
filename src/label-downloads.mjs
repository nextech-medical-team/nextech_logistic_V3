import {currentPartialSkuPdf} from './label-sku-copy.mjs';
import {isDeepStrictEqual} from 'node:util';
import {blobStore} from './blob-store.mjs';
import path from 'node:path';
import {labelWorkbook} from './label-workbook.mjs';
import {randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {currentParcelPdf} from './parcel-pdf.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';
import {managerSql} from './account-manager.mjs';
let store=null;
export function configureExportStore(directory){store=blobStore(directory);}
const storage=()=>store||blobStore(process.env.EXPORT_DIR||path.resolve(process.env.DATA_DIR||'data','exports'));
export const sortModes=['selection','date','manager','sku','supplier','supplier_sku'];
export function labelDownloadFilename(input,job,now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 const stamp=`${parts.year}-${parts.month}-${parts.day}_${parts.hour}h${parts.minute}m${parts.second}s`;
 const selections=[['ids','commande'],['deliveryIds','livraison'],['temuReferences','reference-TEMU']].flatMap(([key,label])=>{const n=new Set(input[key]||[]).size;return n?[`${n}-${label==='reference-TEMU'?(n>1?'references-TEMU':'reference-TEMU'):label+(n>1?'s':'')}`]:[];});
 const managers={amazon_standard:'Amazon-Standard',amazon_prime:'Amazon-Prime',amazon_priority:'Amazon-Priority',shopify_boutique:'Nextech-Boutique',shopify_relay:'Nextech-Relais',temu:'TEMU',tender:'Appels-offres',samples:'Echantillons',rakuten:'Rakuten'};
 const items=job.items||[],unique=[...new Set(items.map(x=>x.manager))];
 const scope=items.length===1?items[0].reference:unique.length===1&&managers[unique[0]]?managers[unique[0]]:'';
 const safe=String(scope).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,45);
 const tri={selection:'selection',date:'date',manager:'gestionnaire',sku:'SKU-Erplain',supplier:'fournisseur',supplier_sku:'fournisseur-puis-SKU-Erplain'}[input.sort||'selection'];
 return ['Etiquettes',stamp,safe,...selections,`${job.labels||0}-etiquette${job.labels===1?'':'s'}`,items.some(x=>x.problems?.length)?'incomplet':'',`tri-${tri}`].filter(Boolean).join('_')+'.pdf';
}
export function sortLabelOrders(rows,mode){
 if(!sortModes.includes(mode))throw Error('Ordre de préparation invalide');
 const compare=(a,b)=>!a&&!b?0:!a?1:!b?-1:String(a).localeCompare(String(b),'fr',{numeric:true});
 const sku=o=>(o.skus||[]).filter(Boolean).sort(compare)[0];
 const key=o=>mode==='date'?dateKey(o):mode==='manager'?o.account_manager:mode==='sku'?sku(o):['supplier','supplier_sku'].includes(mode)?o.source_payload?.supplier:'';
 return mode==='selection'?rows:[...rows].sort((a,b)=>compare(key(a),key(b))||(mode==='supplier_sku'?compare(sku(a),sku(b)):0)||compare(a.reference,b.reference));
}
function dateKey(o){const s=o.source_date||'';const m=/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(s);return m?`${m[3].length===2?'20':''}${m[3]}-${m[2]}-${m[1]}`:s||String(o.received_at||'');}
export async function buildLabelDownload(db,input,job,options={}){
 const {ids=[],deliveryIds=[],temuReferences=[],sort='selection'}=input;
 job.sort=sort;job.items=[];job.percent=0;job.stage='Lecture de la sélection';job.status='running';const docs=[];
 async function add(pdf,item,transform,source={}){try{const data=transform?await transform():Buffer.from(pdf);await PDFDocument.load(data);docs.push({data,item,source});item.labels++;}catch(e){item.problems.push('PDF non exploitable : '+e.message);}}
 const rows=[];for(const id of ids){const o=(await db.query(`SELECT orders.*,${managerSql} AS account_manager,(SELECT tracking FROM carrier_jobs WHERE order_id=orders.id) export_tracking,(SELECT array_agg(DISTINCT coalesce(nullif(l.target_sku,''),nullif(m.target_sku,''),CASE WHEN orders.channel IN ('tender','samples') THEN l.source_sku END)) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id) skus FROM orders WHERE id=$1`,[id])).rows[0];rows.push(o||{id,reference:id,absent:true});}
 const total=ids.length+deliveryIds.length+temuReferences.length;let done=0;
 const item=(reference,extra={})=>{const r={reference,labels:0,problems:[],...extra};job.items.push(r);return r;};
 const progress=()=>{job.percent=Math.floor(++done/total*60);job.stage=`Lecture des commandes : ${done}/${total}`;};
 for(const o of sortLabelOrders(rows,sort)){
  const r=item(o.reference,{id:o.id,manager:o.account_manager,skus:o.skus||[],supplier:o.source_payload?.supplier||null});
  if(o.absent){r.problems.push('Commande introuvable');progress();continue;}
  if(o.channel==='temu'&&!o.transport_choice)for(const p of (await db.query('SELECT pdf,package FROM temu_label_documents WHERE reference=$1 ORDER BY package',[o.reference])).rows)await add(p.pdf,r,()=>currentTemuPdf(db,p.pdf,o.reference,p.package),{order:o,bl:o.erp_live?.bl,carrier:'TEMU',tracking:[]});
  const q=o.partial_mode?"SELECT d.pdf,d.document_index,d.delivery_id,p.bl,p.carrier,p.tracking FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 AND p.status='ready' ORDER BY p.created_at,p.id,d.document_index":"SELECT d.pdf,d.document_index FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.status='ready' ORDER BY d.document_index";
  for(const d of (await db.query(q,[o.id])).rows)await add(d.pdf,r,o.partial_mode?()=>currentPartialSkuPdf(db,d.pdf,d.delivery_id,d.document_index):()=>currentParcelPdf(db,d.pdf,o.id,d.document_index),{order:o,bl:o.partial_mode?d.bl:o.erp_live?.bl,carrier:d.carrier||o.carrier,tracking:d.tracking||o.export_tracking||[]});
  for(const d of (await db.query("SELECT id,pdf FROM extra_parcels WHERE order_id=$1 AND status='ready' ORDER BY created_at,id",[o.id])).rows)await add(d.pdf,r,()=>currentParcelPdf(db,d.pdf,o.id,0,d.id),{order:o,bl:o.partial_mode?null:o.erp_live?.bl,carrier:o.carrier,tracking:o.export_tracking||[]});
  if(!r.labels&&!r.problems.length)r.problems.push('Aucune étiquette prête');progress();
 }
 for(const id of deliveryIds){const d=(await db.query('SELECT p.order_id,o.reference,p.bl,p.carrier,p.tracking,to_jsonb(o) export_order FROM partial_deliveries p JOIN orders o ON o.id=p.order_id WHERE p.id=$1',[id])).rows[0];if(d&&ids.includes(d.order_id)){progress();continue;}const r=item((d?.reference||id)+' · livraison partielle');for(const p of (await db.query("SELECT p.pdf,p.document_index FROM partial_documents p JOIN partial_deliveries d ON d.id=p.delivery_id WHERE d.id=$1 AND d.status='ready' ORDER BY p.document_index",[id])).rows)await add(p.pdf,r,()=>currentPartialSkuPdf(db,p.pdf,id,p.document_index),{order:d?.export_order,bl:d?.bl,carrier:d?.carrier,tracking:d?.tracking||[]});if(!r.labels)r.problems.push('Aucune étiquette prête');progress();}
 for(const ref of temuReferences){
  const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[ref])).rows[0];
  if(o&&ids.includes(o.id)){progress();continue;}
  const r=item(ref+' · TEMU');
  if(o?.transport_choice){
   for(const p of (await db.query("SELECT d.pdf,d.document_index FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.status='ready' ORDER BY d.document_index",[o.id])).rows)await add(p.pdf,r,()=>currentParcelPdf(db,p.pdf,o.id,p.document_index),{order:o,bl:o.erp_live?.bl,carrier:o.carrier,tracking:[]});
  }else for(const p of (await db.query('SELECT pdf,package FROM temu_label_documents WHERE reference=$1 ORDER BY package',[ref])).rows)await add(p.pdf,r,()=>currentTemuPdf(db,p.pdf,ref,p.package),{order:o,bl:o?.erp_live?.bl,carrier:'TEMU',tracking:[]});
  if(o)for(const p of (await db.query("SELECT id,pdf,carrier,tracking FROM extra_parcels WHERE order_id=$1 AND status='ready' ORDER BY created_at,id",[o.id])).rows)await add(p.pdf,r,()=>currentParcelPdf(db,p.pdf,o.id,0,p.id),{order:o,bl:o.erp_live?.bl,carrier:p.carrier,tracking:[p.tracking]});
  if(!r.labels)r.problems.push('Aucune nouvelle étiquette prête');progress();
 }
 if(!docs.length)throw Error('Aucune étiquette disponible dans cette sélection. Consultez le détail ci-dessous.');
 const pdf=await PDFDocument.create();let n=0;job.exportSources=[];
 for(const d of docs){const source=await PDFDocument.load(d.data);const pages=await pdf.copyPages(source,source.getPageIndices());const first=pdf.getPageCount()+1;d.item.firstPage??=first;for(const p of pages)pdf.addPage(p);d.item.lastPage=pdf.getPageCount();job.exportSources.push({source:d.source,reference:d.item.reference,pages:Array.from({length:pages.length},(_,i)=>first+i)});job.percent=60+Math.floor(++n/docs.length*24);job.stage=`Assemblage des étiquettes : ${n}/${docs.length}`;await new Promise(r=>setTimeout(r,0));}
 job.pdf=Buffer.from(await pdf.save());job.labels=docs.length;job.pages=pdf.getPageCount();job.filename=labelDownloadFilename(input,job);job.percent=85;job.stage="Préparation Excel des BL";job.includeExcel=input.includeExcel===true;if(job.includeExcel)job.xlsx=await labelWorkbook(job,options);job.percent=100;job.status='complete';job.stage=job.includeExcel?'PDF et Excel prêts à télécharger':'PDF prêt à télécharger';
}

export async function initializeLabelDownloads(db){await db.exec("CREATE TABLE IF NOT EXISTS label_export_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,input JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending',state JSONB NOT NULL DEFAULT '{}',pdf_key TEXT,xlsx_key TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 day'); CREATE INDEX IF NOT EXISTS export_jobs_queue ON label_export_jobs(status,created_at); CREATE UNIQUE INDEX IF NOT EXISTS export_owner_active ON label_export_jobs(owner) WHERE status IN ('pending','running'); CREATE UNIQUE INDEX IF NOT EXISTS export_request ON label_export_jobs(owner,(input->>'requestId')) WHERE input->>'requestId' IS NOT NULL;");if(db.recoverInterrupted!==false)await db.query("UPDATE label_export_jobs SET status='pending' WHERE status='running'");}
export function labelDownloadWorker(db){let running=false;return {get running(){return running;},async run(){if(running)return;running=true;let row;try{row=await db.transaction(async tx=>{const r=(await tx.query("SELECT * FROM label_export_jobs WHERE status='pending' AND expires_at>now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(r)await tx.query("UPDATE label_export_jobs SET status='running' WHERE id=$1",[r.id]);return r;});if(!row)return;
 const j={id:row.id,status:'running',percent:0,items:[]};let saves=Promise.resolve();const state=()=>{const {pdf,xlsx,exportSources,...data}=j;return JSON.stringify(data);};const save=()=>{const data=state();saves=saves.then(()=>db.query('UPDATE label_export_jobs SET state=$2 WHERE id=$1',[row.id,data]));};const timer=setInterval(save,2000);timer.unref();
 try{await buildLabelDownload(db,row.input,j);const pdfKey=await storage().put(j.pdf),xlsxKey=j.xlsx?await storage().put(j.xlsx):null;clearInterval(timer);await saves;await db.transaction(async tx=>{await tx.query("UPDATE label_export_jobs SET status='complete',state=$2,pdf_key=$3,xlsx_key=$4 WHERE id=$1",[row.id,state(),pdfKey,xlsxKey]);await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'labels.download.prepared',$2)",[row.owner,JSON.stringify({id:row.id,labels:j.labels,selected:j.items.length})]);});}
 catch(e){clearInterval(timer);await saves.catch(()=>{});j.status='failed';j.error=e.message;await db.query("UPDATE label_export_jobs SET status='failed',state=$2 WHERE id=$1",[row.id,state()]);}
 }finally{running=false;}}};}
export async function labelDownloadRoutes(ctx){
 const {p,req,res,db,user,body,json}=ctx;if(!p.startsWith('/api/labels/batches'))return false;
 if(p==='/api/labels/batches'&&req.method==='POST'){
  const input=await body(req);for(const k of ['ids','deliveryIds','temuReferences']){input[k]??=[];if(!Array.isArray(input[k])||input[k].some(x=>typeof x!=='string'||!x||x.length>200))throw Error('Sélection invalide');input[k]=[...new Set(input[k])];}
  const count=input.ids.length+input.deliveryIds.length+input.temuReferences.length;if(count<1)throw Error('Sélectionner au moins une commande ou livraison');input.sort??='selection';if(!sortModes.includes(input.sort))throw Error('Tri invalide');
  if(input.requestId&&!/^[a-f0-9-]{36}$/i.test(input.requestId))throw Error('Identifiant de téléchargement invalide');
  const existing=(await db.query("SELECT id,input FROM label_export_jobs WHERE owner=$1 AND status IN ('pending','running') ORDER BY created_at LIMIT 1",[user.email])).rows[0];if(existing){if(isDeepStrictEqual(existing.input,input)){json(res,202,{id:existing.id});return true;}throw Error('Un téléchargement est déjà en cours pour ce compte');}
  const id=randomUUID();const result=await db.query('INSERT INTO label_export_jobs(id,owner,input) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[id,user.email,JSON.stringify(input)]);if(!result.rows.length){const old=(await db.query("SELECT id,input FROM label_export_jobs WHERE owner=$1 AND input->>'requestId'=$2",[user.email,input.requestId])).rows[0];if(!old||!isDeepStrictEqual(old.input,input))throw Error('Validation déjà utilisée');json(res,202,{id:old.id});return true;}json(res,202,{id});return true;
 }
 const id=new URL(req.url,'http://local').searchParams.get('id'),row=(await db.query('SELECT * FROM label_export_jobs WHERE id=$1 AND owner=$2 AND expires_at>now()',[id,user.email])).rows[0];if(!row){json(res,404,{error:'Téléchargement expiré ou introuvable. Relancez la préparation du PDF.'});return true;}
 const j={...row.state,id:row.id,status:row.status};
 if(p==='/api/labels/batches/file'&&req.method==='GET'){if(j.status!=='complete')throw Error('PDF pas encore prêt');res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="'+j.filename+'"');res.end(await storage().get(row.pdf_key));return true;}
 if(p==='/api/labels/batches/excel'&&req.method==='GET'){if(j.status!=='complete')throw Error('Excel pas encore prêt');if(!row.xlsx_key){json(res,404,{error:'Excel non demandé pour cette extraction'});return true;}res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="'+j.excelFilename+'"');res.end(await storage().get(row.xlsx_key));return true;}
 if(p==='/api/labels/batches/status'&&req.method==='GET'){json(res,200,j);return true;}return false;
}
