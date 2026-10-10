import {pdfToken,saveSkuCopy,skuTextBlocks,savedSkuCopy,skuContextHash} from './label-sku-copy.mjs';
import {currentParcelPdf} from './parcel-pdf.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';
import {labelAttachment} from './label-attachment.mjs';
export async function skuDocuments(db,id){
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];if(!o)throw Error('Commande introuvable');const docs=[],contextHash=await skuContextHash(db,id);
 const add=async(key,raw,current,kind,tracking,grouped=false)=>{const {blocks}=await skuTextBlocks(current,kind);const skus=[...new Set(blocks.flatMap(b=>[...b.value.matchAll(/(?:^|(?<=\) ))([^()]+?)(?= \([\d ,.]+(?: pcs)?\))/g)].map(m=>m[1])))];const mentions=blocks.flatMap(b=>[...b.value.matchAll(/(?:^|(?<=\) ))([^()]+?) \(([\d ,.]+)(?: pcs)?\)/g)].map(m=>({sku:m[1],units:m[2]})));docs.push({key,raw,current,kind,tracking,skus,mentions,grouped,contextHash,orderId:id,token:await pdfToken(current)+':'+contextHash});};
 for(const d of (await db.query('SELECT d.*,c.carrier,c.tracking FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=$1 ORDER BY document_index',[id])).rows)await add('carrier:'+id+':'+d.document_index,d.pdf,await currentParcelPdf(db,d.pdf,id,d.document_index),d.carrier,d.tracking?.[d.document_index]);
 for(const d of (await db.query('SELECT * FROM temu_label_documents WHERE reference=$1 ORDER BY package',[o.reference])).rows){const j=(await db.query('SELECT result FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0],parcel=j?.result?.packageInfoResultList?.find(p=>p.packageSn===d.package),grouped=new Set((parcel?.orderSendInfoList||[]).map(l=>l.parentOrderSn)).size>1;await add('temu:'+o.reference+':'+d.package,d.pdf,await currentTemuPdf(db,d.pdf,o.reference,d.package),'temu',parcel?.trackingNumber,grouped);}
 for(const d of (await db.query("SELECT * FROM extra_parcels WHERE order_id=$1 AND pdf IS NOT NULL AND status='ready' ORDER BY created_at,id",[id])).rows)await add('extra:'+d.id,d.pdf,await currentParcelPdf(db,d.pdf,id,0,d.id),d.carrier,d.tracking);
 for(const d of (await db.query("SELECT d.*,p.carrier,p.tracking FROM partial_documents d JOIN partial_deliveries p ON p.id=d.delivery_id WHERE p.order_id=$1 AND p.status='ready' ORDER BY delivery_id,document_index",[id])).rows){const key='partial:'+d.delivery_id+':'+d.document_index;await add(key,d.pdf,await savedSkuCopy(db,d.pdf,key)||d.pdf,d.carrier,d.tracking?.[d.document_index]);}
 if(contextHash!==await skuContextHash(db,id))throw Error('Commande modifiée pendant la lecture : actualisez avant de corriger les SKU.');return {order:o,docs};
}
export async function skuCopyRoutes(ctx){
 const {p,req,res,db,user,body,json,permitted}=ctx;if(!p.startsWith('/api/labels/sku-copy'))return false;
 permitted(user,['admin','manager','operator']);const url=new URL(req.url,'http://local');
 if(req.method==='GET'){
  const {order,docs}=await skuDocuments(db,url.searchParams.get('id'));
  if(p==='/api/labels/sku-copy/file'){const d=docs.find(d=>d.key===url.searchParams.get('key'));if(!d)throw Error('Étiquette introuvable');res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');const parts=d.key.split(':');await labelAttachment(db,res,parts[0]==='partial'?'partial':'order',parts[0]==='partial'?parts[1]:order.id,parts[0]==='partial'||parts[0]==='carrier'?Number(parts[2])+1:parts[0]==='temu'?parts[2]:1);res.end(d.current);return true;}
  if(p!=='/api/labels/sku-copy')return false;
  json(res,200,{reference:order.reference,documents:docs.map(({key,kind,tracking,skus,mentions,token,grouped})=>({key,kind,tracking,skus,mentions,token,grouped})),message:docs.length?'Seules les mentions SKU et nombre d’unités du PDF seront modifiées. Suivi, transporteur, BC, BL et stock restent inchangés.':'Aucune étiquette existante. Cette action ne crée ni expédition ni achat.'});return true;
 }
 if(p==='/api/labels/sku-copy'&&req.method==='POST'){
  const b=await body(req);if(b.confirmed!==true)throw Error('Confirmer la modification des mentions SKU et nombre d’unités du PDF uniquement.');
  const result=await db.transaction(async tx=>{
   await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[b.id]);
   const {docs}=await skuDocuments(tx,b.id);const item=docs.find(d=>d.key===b.key);if(!item)throw Error('Étiquette existante introuvable.');
   if(item.token!==b.token)throw Error('Étiquette modifiée depuis l’ouverture. Actualisez avant de confirmer.');
   return saveSkuCopy(tx,item,b.replacements,user.email);
  });json(res,200,{ok:true,id:result.id,message:'SKU et nombre d’unités actualisés sur le PDF. Même suivi et même transporteur. Réimprimez cette version. BC et BL inchangés.'});return true;
 }
 return false;
}
