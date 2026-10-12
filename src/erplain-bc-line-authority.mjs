import {createHash,randomUUID} from 'node:crypto';
import {resolutionBcLines} from './resolution-bc-scope.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const identified=id=>(typeof id==='number'&&Number.isSafeInteger(id)&&id>0)||(typeof id==='string'&&/^[1-9]\d*$/.test(id));
export const bcAuthorityLineVersion=lines=>digest([...lines].sort((a,b)=>String(a.id).localeCompare(String(b.id))).map(l=>[l.id,l.source_line,l.source_sku,Number(l.quantity),l.target_sku??null,l.target_quantity==null?null:Number(l.target_quantity),l.source_payload]));
export function authoritativeBcLines(order,bc){
 const rows=resolutionBcLines(order,bc),seen=new Set();
 return rows.filter(l=>l.variant).map(l=>{
  const q=l.quantity;
  if(!identified(l.id)||!identified(l.variant?.id)||typeof l.variant.sku!=='string'||!l.variant.sku.trim()||seen.has(String(l.id))||!['number','string'].includes(typeof q)||String(q).trim()===''||!Number.isFinite(Number(q))||Number(q)<0)throw Error('Erplain · Lignes BC non identifiées ou quantités invalides : aucune ligne V3 remplacée');
  seen.add(String(l.id));return {id:String(l.id),variantId:String(l.variant.id),sku:l.variant.sku,quantity:Number(q),type:l.type||'product',label:l.label||l.description||l.variant.sku};
 }).filter(l=>l.quantity>0);
}
const signature=rows=>digest(rows.map(l=>[l.id,l.type,l.variantId,l.sku,l.quantity]).sort((a,b)=>a[0].localeCompare(b[0])));
export function bcAuthorityIdentityMatches(order,bc,lines){
 const authority=order.erp_live?.bcLineAuthority;
 if(authority?.source!=='erplain_bc'||String(authority.bcId)!==String(bc.id))return false;
 let expected;try{expected=authoritativeBcLines(order,bc);}catch{return false;}
 if(authority.signature!==signature(expected)||expected.length!==lines.length)return false;
 const ids=new Set();
 return lines.every(l=>{
  const p=l.source_payload||{},e=expected.find(x=>x.id===String(p.erplainBcLineId));
  if(!e||ids.has(e.id))return false;ids.add(e.id);
  return p.mappingScope==='order'&&String(p.erplainBcId)===String(bc.id)&&String(p.erplainSourceVariantId)===e.variantId&&String(p.erplainVariantId)===e.variantId&&l.target_sku===e.sku&&Number(l.target_quantity)===e.quantity;
 });
}

// Called only by an explicit BC refresh, inside the document transaction.
// Original imported fields and the prior projection remain in the audit.
export async function adoptErplainBcLines(tx,id,bc,expectedVersion){
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!order)throw Error('Commande V3 introuvable pendant actualisation BC');
 await assertDocumentIdle(tx,id);
 const local=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
 if(bcAuthorityLineVersion(local)!==expectedVersion)throw Error('Lignes V3 modifiées pendant la lecture : actualisation BC différée');
 const rows=authoritativeBcLines(order,bc),available=new Set(local.map(l=>l.id)),next=[];
 for(const row of rows){
  const candidates=[l=>String(l.source_payload?.erplainBcId)===String(bc.id)&&String(l.source_payload?.erplainBcLineId)===row.id,l=>String(l.source_line)===row.id,l=>String(l.source_payload?.erplainSourceVariantId||l.source_payload?.erplainVariantId||'')===row.variantId,l=>(l.target_sku||l.source_sku)===row.sku];
  let old;
  for(const matches of candidates){old=local.find(l=>available.has(l.id)&&matches(l));if(old)break;}
  // A changed BC may replace every imported product. Reuse local row IDs to
  // preserve references; this pairing is history, never a global equivalence.
  old ||= local.find(l=>available.has(l.id));
  if(old)available.delete(old.id);
  const payload={...(old?.source_payload||{}),mappingScope:'order',erplainBcId:String(bc.id),erplainBcLineId:row.id,erplainSourceVariantId:row.variantId,erplainVariantId:row.variantId,erplainBcLabel:row.label};
  if(old&&!payload.erplainBcOriginal)payload.erplainBcOriginal={sourceSku:old.source_sku,sourceQuantity:old.quantity,targetSku:old.target_sku,targetQuantity:old.target_quantity,variantId:old.source_payload?.erplainSourceVariantId||old.source_payload?.erplainVariantId||null};
  if(old&&(old.target_sku||old.source_sku)!==row.sku){delete payload.erplainCorrectedWeightKg;}
  next.push({...old,id:old?.id||randomUUID(),order_id:id,source_line:old?.source_line||(order.source_payload?.erplainImported?row.id:'ERP-BC:'+bc.id+':'+row.id),source_sku:old?.source_sku||row.sku,quantity:old?.quantity??row.quantity,target_sku:row.sku,target_quantity:row.quantity,source_payload:payload});
 }
 const changed=bcAuthorityLineVersion(local)!==bcAuthorityLineVersion(next);
 if(changed){
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.bc_lines_adopted',$1::jsonb)",[JSON.stringify({orderId:id,bcId:String(bc.id),source:'explicit_bc_refresh',before:local,after:next,externalWrites:0,labelsTouched:0})]);
  for(const l of next){
   if(local.some(old=>old.id===l.id))await tx.query('UPDATE lines SET target_sku=$2,target_quantity=$3,source_payload=$4::jsonb WHERE id=$1 AND order_id=$5',[l.id,l.target_sku,l.target_quantity,JSON.stringify(l.source_payload),id]);
   else await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,target_sku,target_quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[l.id,id,l.source_line,l.source_sku,l.quantity,l.target_sku,l.target_quantity,JSON.stringify(l.source_payload)]);
  }
  for(const old of local)if(available.has(old.id))await tx.query('DELETE FROM lines WHERE id=$1 AND order_id=$2',[old.id,id]);
 }
 const authority={source:'erplain_bc',bcId:String(bc.id),checkedAt:new Date().toISOString(),signature:signature(rows),lineCount:rows.length,originalImportPreserved:true,preparationNotStarted:true};
 await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bcLineAuthority}',$2::jsonb,true)-'stockCheckedAt'-'verifiedAt'-'labelPreparationFingerprint' WHERE id=$1",[id,JSON.stringify(authority)]);
 return {...authority,changed};
}
