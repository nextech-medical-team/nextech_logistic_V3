import {currentPartialSkuPdf} from './label-sku-copy.mjs';
import {skuCopyRoutes} from './label-sku-routes.mjs';
import {assertLabelStockGate,shipmentFingerprint} from './label-stock-gate.mjs';
import {currentParcelPdf} from './parcel-pdf.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';
import {labelDownloadRoutes,labelDownloadFilename} from './label-downloads.mjs';
import {PDFDocument} from 'pdf-lib';
import {addressIssue} from './domain.mjs';
import {queueCarrierLabels} from './carrier-jobs.mjs';
export async function mergeLabels(documents){
 if(!documents.length)throw new Error('Aucune étiquette disponible');
 if(documents.reduce((n,d)=>n+d.length,0)>80*1024*1024)throw new Error('Sélection PDF trop volumineuse : réduire le lot');
 const output=await PDFDocument.create();for(const bytes of documents){const source=await PDFDocument.load(bytes);const pages=await output.copyPages(source,source.getPageIndices());for(const page of pages)output.addPage(page);}return Buffer.from(await output.save());
}
export const canCompleteLabel=user=>user.role==='admin'||!!user.permissions?.includes('labels.complete');
export async function labelTools({p,req,res,db,user,body,json,audit,permitted}){
 if(await skuCopyRoutes({p,req,res,db,user,body,json,permitted}))return true;
 if(await labelDownloadRoutes({p,req,res,db,user,body,json,audit}))return true;
 if(p==='/api/labels/download-all'&&req.method==='POST'){
  const {ids=[],temuReferences=[],deliveryIds=[]}=await body(req);
  if(!Array.isArray(ids)||!Array.isArray(temuReferences)||!Array.isArray(deliveryIds)||ids.length+temuReferences.length+deliveryIds.length<1||ids.length+temuReferences.length+deliveryIds.length>100||[...ids,...temuReferences,...deliveryIds].some(x=>typeof x!=='string'))throw new Error('Sélectionner de 1 à 100 commandes ou livraisons');
  const documents=[],missing=[];
  for(const id of [...new Set(ids)]){
   const o=(await db.query('SELECT reference,partial_mode FROM orders WHERE id=$1',[id])).rows[0];if(!o)throw new Error('Commande introuvable');
   const query=o.partial_mode?"SELECT d.pdf,d.delivery_id,d.document_index FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 AND p.status='ready' ORDER BY p.created_at,d.document_index":"SELECT d.pdf FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.status='ready' ORDER BY d.document_index";
   const rows=(await db.query(query,[id])).rows;if(!rows.length)missing.push(o.reference);else {if(o.partial_mode){for(const r of rows)documents.push(await currentPartialSkuPdf(db,r.pdf,r.delivery_id,r.document_index));}else for(let i=0;i<rows.length;i++)documents.push(await currentParcelPdf(db,rows[i].pdf,id,i));const extras=(await db.query("SELECT id,pdf FROM extra_parcels WHERE order_id=$1 AND status='ready' ORDER BY created_at",[id])).rows;for(const r of extras)documents.push(await currentParcelPdf(db,r.pdf,id,0,r.id));}
  }
  for(const id of [...new Set(deliveryIds)]){
   const d=(await db.query('SELECT d.order_id,o.reference FROM partial_deliveries d JOIN orders o ON o.id=d.order_id WHERE d.id=$1',[id])).rows[0];if(!d)throw new Error('Livraison introuvable');if(ids.includes(d.order_id))continue;
   const rows=(await db.query("SELECT p.pdf,p.delivery_id,p.document_index FROM partial_documents p JOIN partial_deliveries d ON d.id=p.delivery_id WHERE d.id=$1 AND d.status='ready' ORDER BY p.document_index",[id])).rows;if(!rows.length)missing.push(d.reference+' (livraison partielle)');else documents.push(...rows.map(r=>Buffer.from(r.pdf)));
  }
  for(const reference of [...new Set(temuReferences)]){
   const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];if(o&&ids.includes(o.id))continue;const before=documents.length;
   if(o?.transport_choice){for(const r of (await db.query("SELECT d.pdf,d.document_index FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 AND c.status='ready' ORDER BY d.document_index",[o.id])).rows)documents.push(await currentParcelPdf(db,r.pdf,o.id,r.document_index));}
   else for(const r of (await db.query('SELECT pdf,package FROM temu_label_documents WHERE reference=$1 ORDER BY package',[reference])).rows)documents.push(await currentTemuPdf(db,r.pdf,reference,r.package));
   if(o)for(const r of (await db.query("SELECT id,pdf FROM extra_parcels WHERE order_id=$1 AND status='ready' ORDER BY created_at,id",[o.id])).rows)documents.push(await currentParcelPdf(db,r.pdf,o.id,0,r.id));
   if(before===documents.length)missing.push(reference);
  }
  if(missing.length)throw new Error('Aucune étiquette prête pour : '+missing.join(', ')+'. Retirez ces commandes de la sélection.');
  const pdf=await mergeLabels(documents);await audit(user,'labels.download.batch',{orders:ids.length,deliveries:deliveryIds.length,temu:temuReferences.length,documents:documents.length});res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${labelDownloadFilename({ids,deliveryIds,temuReferences},{labels:documents.length})}"`);res.end(pdf);return true;
 }
 if(p==='/api/users/label-permission'&&req.method==='POST'){
  permitted(user,['admin']);const b=await body(req);if(typeof b.enabled!=='boolean'||typeof b.email!=='string')throw new Error('Permission invalide');
  const result=await db.query("UPDATE users SET permissions=(permissions-'labels.complete') || $2::jsonb WHERE email=$1 RETURNING email",[b.email,JSON.stringify(b.enabled?['labels.complete']:[])]);if(!result.rows.length)throw new Error('Utilisateur introuvable');await audit(user,'user.labels.complete.permission',{email:b.email,enabled:b.enabled});json(res,200,{ok:true});return true;
 }
 if(p==='/api/labels/complete'&&req.method==='POST'){
  if(!canCompleteLabel(user)){const e=new Error('Droit spécifique de complément d’étiquette requis');e.status=403;throw e;}
  const b=await body(req),address={};for(const k of ['name','street','postal','city','country','phone','email'])address[k]=String(b.address?.[k]||'').trim().slice(0,200);address.country=address.country.toUpperCase();
  const issue=addressIssue(address);if(issue)throw new Error(issue);if(!/^[A-Z]{2}$/.test(address.country))throw new Error('Pays ISO à deux lettres requis');
  const weight=Number(b.weight);if(!Number.isFinite(weight)||weight<=0||weight>3000)throw new Error('Poids total en kg requis');if(!['gls','gls_pharma','gofo'].includes(b.carrier))throw new Error('Transporteur direct requis');
  await db.transaction(async tx=>{
   const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(!o||o.partial_mode||o.channel==='temu')throw new Error('Commande absente ou circuit non compatible');
   if(o.channel==='shopify'&&o.source_payload?.shopifyDeliveryMode==='relay')throw new Error('Commande Relais GLS : circuit GLS Shop requis, aucune création domicile autorisée');
   const existing=(await tx.query('SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];const heldPending=existing?.status==='pending'&&o.resolution_pending_resume===true;
   if(existing&&((existing.status!=='failed'&&!heldPending)||existing.result||existing.tracking?.length))throw new Error('Expédition existante ou incertaine : aucune recréation autorisée');
   await tx.query('SELECT id FROM lines WHERE order_id=$1 ORDER BY id FOR SHARE',[o.id]);
   await assertLabelStockGate(tx,o);
   await tx.query("UPDATE orders SET address=$2,recipient=$3,weight_kg=$4,carrier=$5,parcel_count=$6,label_override=true,label_status='simulated',resolution_pending_resume=false,issue=null WHERE id=$1",[o.id,JSON.stringify(address),address.name,weight,b.carrier,b.carrier.startsWith('gls')?Math.ceil(weight/30):1]);
   const completed=(await tx.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
   const fingerprint=await shipmentFingerprint(tx,completed);
   await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{labelPreparationFingerprint}',to_jsonb($2::text)) WHERE id=$1",[o.id,fingerprint]);
   await assertLabelStockGate(tx,(await tx.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0]);
   await tx.query("UPDATE jobs SET status='complete',error=null WHERE order_id=$1 AND kind='label'",[o.id]);
   if(existing)await tx.query("UPDATE carrier_jobs SET carrier=$2,status='pending',attempts=0,error=null,updated_at=now() WHERE order_id=$1",[o.id,b.carrier.startsWith('gls')?'gls':'gofo']);else await queueCarrierLabels(tx,[o.id]);
  });await audit(user,'label.manual.completed',{orderId:b.id,weight,carrier:b.carrier,erplainChanged:false});json(res,202,{message:'Informations transport enregistrées. Génération relancée dans le circuit existant (TEST par défaut). Aucun document Erplain existant modifié.'});return true;
 }
 return false;
}


