import {randomUUID} from 'node:crypto';
import {skuDocuments} from './label-sku-routes.mjs';
import {digest,skuContextHash} from './label-sku-copy.mjs';

// Retain the exact currently served PDF before changing the preparation lines.
// The carrier source and tracking are never changed by this operation.
export async function preserveSubstitutionLabels(db,orderId){
 const {docs}=await skuDocuments(db,orderId);
 for(const d of docs){
  const key='preserved:'+d.key;
  const existing=(await db.query('SELECT source_hash,pdf FROM label_sku_copies WHERE document_key=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[key])).rows[0];
  if(existing){if(existing.source_hash!==digest(d.raw)||!Buffer.from(existing.pdf).equals(Buffer.from(d.current)))throw Error('Étiquette préservée différente : rapprochement requis avant remplacement');continue;}
  if(d.contextHash!==await skuContextHash(db,orderId))throw Error('Commande modifiée pendant la préservation des étiquettes : actualisez avant de confirmer');
  await db.query('INSERT INTO label_sku_copies(id,document_key,order_id,source_hash,context_hash,before_pdf,pdf,replacements,user_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),key,orderId,digest(d.raw),d.contextHash,d.current,d.current,'[]','system:substitution-preserve']);
 }
 return docs.map(d=>({key:d.key,sha256:digest(d.current)}));
}
