import {randomUUID} from 'node:crypto';
import {skuDocuments} from './label-sku-routes.mjs';
import {currentTemuPdf} from './temu-label-pdf.mjs';
import {digest,skuContextHash} from './label-sku-copy.mjs';

// Capture served editions, not just carrier sources: SKU corrections can be
// derived from earlier saved editions. Freeze every reference of a shared parcel.
export async function preserveTemuPartialLabels(db,order){
 const related=(await db.query(`SELECT DISTINCT o.id,o.reference,p->>'packageSn' package_sn
 FROM temu_label_jobs j CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.result->'packageInfoResultList')='array' THEN j.result->'packageInfoResultList' ELSE '[]'::jsonb END) p JOIN orders o ON o.channel='temu'
 WHERE p->>'packageSn' IS NOT NULL
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'orderSendInfoList')='array' THEN p->'orderSendInfoList' ELSE '[]'::jsonb END) a WHERE a->>'parentOrderSn'=$1)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'orderSendInfoList')='array' THEN p->'orderSendInfoList' ELSE '[]'::jsonb END) a WHERE a->>'parentOrderSn'=o.reference) ORDER BY o.id,package_sn`,[order.reference])).rows;
 const ids=[...new Set([order.id,...related.map(o=>o.id)])].sort(),kept=[];
 await db.query('SELECT id FROM orders WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids]);
 for(const id of ids){
  let docs;
  if(id===order.id)({docs}=await skuDocuments(db,id));
  else{
   const rows=related.filter(r=>r.id===id),contextHash=await skuContextHash(db,id),reference=rows[0].reference;
   const labels=(await db.query('SELECT * FROM temu_label_documents WHERE reference=$1 AND package=ANY($2::text[]) ORDER BY package',[reference,[...new Set(rows.map(r=>r.package_sn))]])).rows;
   docs=[];for(const d of labels)docs.push({key:'temu:'+reference+':'+d.package,raw:d.pdf,current:await currentTemuPdf(db,d.pdf,reference,d.package),contextHash});
  }
  for(const d of docs){
   const key='preserved:'+d.key,source=digest(d.raw),pdfHash=digest(d.current);
   const old=(await db.query('SELECT source_hash,pdf FROM label_sku_copies WHERE document_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[key])).rows[0];
   if(old&&old.source_hash!==source)throw Error('Source de l’étiquette existante modifiée : rapprochement requis, aucun nouveau BL créé');
   if(d.contextHash!==await skuContextHash(db,id))throw Error('Étiquette ou préparation modifiée pendant la conservation : actualiser avant création du BL');
   // Always reset the edition cutoff, even for equal bytes: changing partial_mode
   // can otherwise select a different subset of old grouped SKU substitutions.
   await db.query('INSERT INTO label_sku_copies(id,document_key,order_id,source_hash,context_hash,before_pdf,pdf,replacements,user_email,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())',[randomUUID(),key,id,source,d.contextHash,d.current,d.current,'[]','system:temu-partial-preserve']);
   kept.push({key:d.key,sha256:pdfHash});
  }
 }
 return kept;
}
