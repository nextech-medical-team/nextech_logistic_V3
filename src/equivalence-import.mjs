import {randomUUID,createHash} from 'node:crypto';
import {parseEquivalenceFile,allocateImportStock} from './equivalence-import-file.mjs';
import {substitution} from './stock-substitution.mjs';
import {validateResolution} from './problem-resolution.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const quantities=rows=>{const sums=new Map();for(const l of rows.filter(l=>l.type==='normal')){const sku=l.variant.sku;sums.set(sku,(sums.get(sku)||0)+Number(l.quantity));}return [...sums].sort();};
export async function initializeEquivalenceImports(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS equivalence_imports(id TEXT PRIMARY KEY,owner TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'checking',selected_lines JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS equivalence_import_rows(batch_id TEXT REFERENCES equivalence_imports(id),line INT NOT NULL,data JSONB NOT NULL,status TEXT NOT NULL,order_id TEXT REFERENCES orders(id),request_id TEXT UNIQUE,job_id TEXT REFERENCES resolution_jobs(id),error TEXT,PRIMARY KEY(batch_id,line));
 CREATE INDEX IF NOT EXISTS equivalence_import_rows_status ON equivalence_import_rows(status,batch_id,line);`);
 if(db.recoverInterrupted!==false)await db.query("UPDATE equivalence_import_rows SET status='blocked',error='Traitement interrompu : rapprocher le BC et la demande avant toute reprise.' WHERE status='starting'");
}
export function equivalenceImportService(db,directory,{api=erplainAccount(directory,'live'),preview=substitution}={}){
 let running=false;
 async function rows(id){return (await db.query('SELECT * FROM equivalence_import_rows WHERE batch_id=$1 ORDER BY line',[id])).rows;}
 async function read(id){
  const batch=(await db.query('SELECT * FROM equivalence_imports WHERE id=$1',[id])).rows[0];if(!batch)throw Error('Import introuvable');
  const items=await rows(id),jobs=items.filter(r=>r.job_id).map(r=>r.job_id);
  const states=jobs.length?(await db.query('SELECT id,status,stage,error,result FROM resolution_jobs WHERE id=ANY($1::text[])',[jobs])).rows:[];
  return {...batch,rows:items.map(r=>({line:r.line,...r.data,plan:undefined,status:r.status,error:r.error,job:states.find(j=>j.id===r.job_id)}))};
 }
 async function analyze(r){
  const data=r.data;
  if(data.error)throw Error(data.error);
  const orders=(await db.query('SELECT * FROM orders WHERE reference=$1 AND channel=ANY($2::text[])',[data.reference,['amazon','shopify','temu']])).rows;
  if(orders.length!==1)throw Error(orders.length?'Numéro de commande ambigu entre canaux':'Commande Amazon, Shopify ou TEMU introuvable (AO exclus)');
  const o=orders[0],blocked=suspensionBlock(o);if(blocked)throw Error(blocked);
  const busy=(await db.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[o.id])).rows.length;
  if(busy)throw Error('Une intervention est déjà en cours pour cette commande');
  const previous=(await db.query("SELECT payload,result,status,error FROM resolution_jobs WHERE order_id=$1 AND action='replace-equivalent' AND payload->>'sku'=$2 AND payload->>'replacementSku'=$3 ORDER BY created_at DESC LIMIT 1",[o.id,data.sku,data.replacementSku])).rows[0];
  if(previous&&Number(previous.payload.replacementQuantity)===data.replacementQuantity&&previous.status==='complete'&&!previous.error){
   const original=(await db.query('SELECT id FROM lines WHERE order_id=$1 AND (target_sku=$2 OR source_sku=$2)',[o.id,data.sku])).rows.length;
   if(!original){
    await api.verify();const live=await api.request('query V3ImportEquivalentAlready($id:ID!){Order(id:$id){id line_items{type quantity variant{sku}}}}',{id:String(o.erp_live?.bc?.id)});
    if(String(live.Order?.id)!==String(o.erp_live?.bc?.id))throw Error('BC demandé non reçu');
    const replacement=live.Order.line_items?.filter(l=>l.type==='normal'&&l.variant?.sku===data.replacementSku).reduce((n,l)=>n+Number(l.quantity),0);
    const old=live.Order.line_items?.some(l=>l.type==='normal'&&l.variant?.sku===data.sku);
    if(old||!(replacement>=data.replacementQuantity))throw Error('Remplacement historique présent mais contenu actuel différent : rapprochement requis');
    await db.query("UPDATE equivalence_import_rows SET status='already',order_id=$3,data=$4,error=null WHERE batch_id=$1 AND line=$2",[r.batch_id,r.line,o.id,JSON.stringify({...data,orderId:o.id,channel:o.channel,country:o.address?.country})]);return;
   }
  }
  if(!o.erp_live?.bc?.id)throw Error('BC Erplain absent : créer ou rapprocher le BC par le parcours de la commande');
  await api.verify();
  const response=await api.request('query V3ImportEquivalentQuantity($id:ID!){Order(id:$id){id line_items{type quantity variant{sku}}}}',{id:String(o.erp_live.bc.id)});
  if(String(response.Order?.id)!==String(o.erp_live.bc.id))throw Error('BC demandé non reçu');
  const originals=response.Order.line_items?.filter(l=>l.type==='normal'&&l.variant?.sku===data.sku);
  if(originals?.length!==1)throw Error('SKU de base absent ou ambigu dans le BC');
  const payload=validateResolution({id:o.id,requestId:randomUUID(),action:'equivalent-preview',type:'stock',sku:data.sku,replacementSku:data.replacementSku,replaceQuantity:Number(originals[0].quantity),replacementQuantity:data.replacementQuantity,scope:'order',resumeAfter:true});
  const plan=await preview(db,api,o,payload,{directory});
  if(!Number.isFinite(plan.available))throw Error('Stock de remplacement non suivi ou non vérifié');
  await db.query("UPDATE equivalence_import_rows SET status='valid',order_id=$3,data=$4,error=null WHERE batch_id=$1 AND line=$2",[r.batch_id,r.line,o.id,JSON.stringify({...data,orderId:o.id,channel:o.channel,country:o.address?.country,replaceQuantity:payload.replaceQuantity,available:plan.available,payload,plan})]);
 }
 async function queue(r){
  await withShipmentLock(async()=>{
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[r.order_id])).rows[0];if(!o)throw Error('Commande disparue');const blocked=suspensionBlock(o);if(blocked)throw Error(blocked);
   const other=(await db.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[o.id])).rows;
   if(other.length)throw Error('Intervention concurrente : attendre et réanalyser le fichier');
   const earlier=(await rows(r.batch_id)).filter(x=>x.order_id===o.id&&x.status==='applied');
   const p=r.data.payload;
   const plan=await preview(db,api,o,p,{directory});
   if(!earlier.length&&plan.previewFingerprint!==r.data.plan.previewFingerprint)throw Error('Commande ou produit modifié depuis l’aperçu : réanalyser le fichier');
   if(earlier.length){
    if(o.erp_live?.equivalentAttemptId!==earlier.at(-1).request_id)throw Error('Commande modifiée hors de cet import : rapprochement requis');
    const first=earlier[0].data.plan.commercialBefore,expected=new Map(quantities(first.line_items));
    for(const e of earlier){expected.set(e.data.sku,(expected.get(e.data.sku)||0)-e.data.replaceQuantity);expected.set(e.data.replacementSku,(expected.get(e.data.replacementSku)||0)+e.data.replacementQuantity);}
    const current=quantities(plan.commercialBefore.line_items);
    if(hash([...expected].filter(([,q])=>q>0).sort())!==hash(current)||Number(plan.replaceQuantity)!==r.data.replaceQuantity||plan.items.at(-1).variant.id!==r.data.plan.items.at(-1).variant.id||plan.weightKg!==r.data.plan.weightKg)throw Error('Produits, quantités ou caractéristiques modifiés : recontrôle nécessaire');
   }
   const requestId=r.request_id||randomUUID(),jobId=randomUUID();
   const payload={...p,requestId,action:'replace-equivalent',confirmEquivalent:true,previewFingerprint:plan.previewFingerprint};validateResolution(payload);
   await db.transaction(async tx=>{
    await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[o.id]);
    if((await tx.query("SELECT id FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[o.id])).rows.length)throw Error('Intervention concurrente détectée');
    const previewRequestId=randomUUID();
    await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,status,stage,result) VALUES($1,$2,$3,'equivalent-preview',$4,'complete','Aperçu validé dans l’import',$5)",[randomUUID(),o.id,previewRequestId,JSON.stringify({...p,requestId:previewRequestId}),JSON.stringify(plan)]);
    await tx.query('INSERT INTO resolution_jobs(id,order_id,request_id,action,payload) VALUES($1,$2,$3,\'replace-equivalent\',$4)',[jobId,o.id,requestId,JSON.stringify({...payload,importRow:{batchId:r.batch_id,line:r.line}})]);
    await tx.query("UPDATE equivalence_import_rows SET status='processing',request_id=$3,job_id=$4,data=$5 WHERE batch_id=$1 AND line=$2 AND status='queued'",[r.batch_id,r.line,requestId,jobId,JSON.stringify({...r.data,plan})]);
    await tx.query("INSERT INTO audit(user_email,action,detail) SELECT owner,'equivalence.import.requested',$2::jsonb FROM equivalence_imports WHERE id=$1",[r.batch_id,JSON.stringify({batchId:r.batch_id,line:r.line,orderId:o.id,jobId,sku:p.sku,replacementSku:p.replacementSku})]);
   });
  },['erplain-live-workflow','stock-mutations']);
 }
 async function block(r,error){
  await db.query("UPDATE equivalence_import_rows SET status='blocked',error=$3 WHERE batch_id=$1 AND line=$2",[r.batch_id,r.line,error]);
  if(r.order_id)await db.query("UPDATE equivalence_import_rows SET status='blocked',error=$3 WHERE batch_id=$1 AND order_id=$2 AND status='queued'",[r.batch_id,r.order_id,'Autre ligne de cette commande bloquée : '+error]);
  if(r.order_id){
   const reason='Import des équivalences bloqué : '+error;
   await db.transaction(async tx=>{
    await tx.query("UPDATE orders SET issue=$2 WHERE id=$1 AND resolution_pending_resume=true AND issue='Import des équivalences : autres lignes sélectionnées en attente'",[r.order_id,reason]);
    await tx.query("UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1 AND status='review' AND error='Import des équivalences : autres lignes sélectionnées en attente'",[r.order_id,reason]);
   });
  }
 }
 return {get running(){return running;},read,
  async routes({p,url,req,res,user,body,json,permitted}){
   if(!p.startsWith('/api/equivalence-import'))return false;permitted(user,['admin','manager']);
   if(req.method==='GET'&&p==='/api/equivalence-import/history'){json(res,200,{rows:(await db.query('SELECT id,owner,status,created_at,updated_at FROM equivalence_imports ORDER BY created_at DESC LIMIT 25')).rows});return true;}
   if(req.method==='GET'&&p==='/api/equivalence-import'){json(res,200,await read(url.searchParams.get('id')));return true;}
   if(req.method==='POST'&&p==='/api/equivalence-import/analyze'){
    const b=await body(req),items=await parseEquivalenceFile(b.file),id=randomUUID();
    await db.transaction(async tx=>{await tx.query('INSERT INTO equivalence_imports(id,owner) VALUES($1,$2)',[id,user.email]);for(const row of items)await tx.query('INSERT INTO equivalence_import_rows(batch_id,line,data,status) VALUES($1,$2,$3,\'checking\')',[id,row.line,JSON.stringify(row)]);});json(res,202,{id});return true;
   }
   if(req.method==='POST'&&p==='/api/equivalence-import/apply'){
    const b=await body(req);if(typeof b.id!=='string'||!Array.isArray(b.lines)||!b.lines.length||b.lines.length>1000||b.lines.some(n=>!Number.isInteger(n))||new Set(b.lines).size!==b.lines.length)throw Error('Sélection invalide');
    const confirm=()=>db.transaction(async tx=>{
     const batch=(await tx.query('SELECT * FROM equivalence_imports WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(!batch)throw Error('Import introuvable');
     if(batch.status==='applying'||batch.status==='complete'){if(hash([...b.lines].sort((a,b)=>a-b))!==hash(batch.selected_lines))throw Error('Cet import a déjà été confirmé avec une autre sélection');return;}
     if(batch.status!=='ready')throw Error('Attendre la fin de l’analyse');
     const items=(await tx.query('SELECT * FROM equivalence_import_rows WHERE batch_id=$1 ORDER BY line',[b.id])).rows;
     if(b.lines.some(n=>!items.some(r=>r.line===n&&r.status==='valid')))throw Error('Ligne non applicable sélectionnée');
     const selected=items.filter(r=>b.lines.includes(r.line)),errors=allocateImportStock(selected.map(r=>({...r.data,line:r.line})),b.lines);if(errors.size)throw Error([...errors.values()][0]);
     await tx.query('SELECT id FROM orders WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[...new Set(selected.map(r=>r.order_id))]]);
     for(const r of selected){
      const same=selected.filter(x=>x.order_id===r.order_id);
      if(same.length>1&&(r.data.plan.partialProof||r.data.plan.historicalStockProof))throw Error('Plusieurs remplacements sur une livraison partielle ou historique : rapprochement requis');
      if(same.some(x=>x.data.sku===r.data.replacementSku))throw Error('Remplacements en chaîne dans une même commande : vérifier les SKU du fichier');
     }
     // One active import per order, including imports accepted by another user.
     if((await tx.query("SELECT r.order_id FROM equivalence_import_rows r JOIN equivalence_imports b ON b.id=r.batch_id WHERE r.order_id=ANY($1::text[]) AND b.status='applying'",[[...new Set(selected.map(r=>r.order_id))]])).rows.length)throw Error('Une commande sélectionnée figure déjà dans un import en cours');
     const reserved=(await tx.query("SELECT r.data,r.order_id FROM equivalence_import_rows r JOIN equivalence_imports b ON b.id=r.batch_id WHERE b.status='applying' AND r.status IN ('queued','processing')")).rows;
     const aggregate=[...selected.map(r=>({...r.data,line:r.line})),...reserved.map((r,i)=>({...r.data,line:-i-1,orderId:r.order_id}))];
     const combinedErrors=allocateImportStock(aggregate);if(selected.some(r=>combinedErrors.has(r.line)))throw Error(combinedErrors.get(selected.find(r=>combinedErrors.has(r.line)).line));
     await tx.query("UPDATE equivalence_import_rows SET status=CASE WHEN line=ANY($2::int[]) THEN 'queued' ELSE CASE WHEN status='valid' THEN 'skipped' ELSE status END END WHERE batch_id=$1",[b.id,b.lines]);
     await tx.query("UPDATE equivalence_imports SET status='applying',selected_lines=$2,updated_at=now() WHERE id=$1",[b.id,JSON.stringify([...b.lines].sort((a,b)=>a-b))]);
    });if(db.withLocks)await db.withLocks(['equivalence-import-confirm'],confirm);else await confirm();json(res,202,await read(b.id));return true;
   }return false;
  },
  async run(){
   if(running)return;running=true;
   try{
    const processing=(await db.query("SELECT r.*,j.status AS job_status,j.error AS job_error,j.result AS job_result FROM equivalence_import_rows r JOIN resolution_jobs j ON j.id=r.job_id WHERE r.status='processing' ORDER BY r.batch_id,r.line")).rows;
    for(const r of processing){if(r.job_status==='review')await block(r,r.job_error||'Commande à vérifier');else if(r.job_status==='complete'){
     if(r.job_result?.statusVerification?.state==='needs_review'&&!r.job_result?.importDeferred)await block(r,r.job_result?.statusVerification?.message||'Remplacement effectué : commande encore à vérifier');
     else await db.query("UPDATE equivalence_import_rows SET status='applied',error=null WHERE batch_id=$1 AND line=$2",[r.batch_id,r.line]);
    }}
    const next=(await db.query("SELECT r.* FROM equivalence_import_rows r WHERE r.status='queued' AND NOT EXISTS(SELECT 1 FROM equivalence_import_rows busy WHERE busy.order_id=r.order_id AND busy.status IN ('processing','starting')) ORDER BY r.batch_id,r.line LIMIT 1")).rows[0];
    if(next){try{await queue(next);}catch(e){await block(next,e.message);}}
    await db.query("UPDATE equivalence_imports b SET status='complete',updated_at=now() WHERE status='applying' AND NOT EXISTS(SELECT 1 FROM equivalence_import_rows r WHERE r.batch_id=b.id AND r.status IN ('queued','processing','starting'))");
    const checking=(await db.query("SELECT * FROM equivalence_import_rows WHERE status='checking' ORDER BY batch_id,line LIMIT 1")).rows[0];
    if(checking){try{await analyze(checking);}catch(e){await block(checking,e.message);}}
    await db.query("UPDATE equivalence_imports b SET status='ready',updated_at=now() WHERE status='checking' AND NOT EXISTS(SELECT 1 FROM equivalence_import_rows r WHERE r.batch_id=b.id AND r.status='checking')");
   }finally{running=false;}
  }
 };
}
