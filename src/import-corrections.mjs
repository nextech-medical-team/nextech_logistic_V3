import {createHash} from 'node:crypto';
import {parseOrders} from './imports.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const active=['processing','running','queued','waiting','creating','awaiting_pdf'];
export async function initializeImportCorrections(db){await db.exec(`CREATE TABLE IF NOT EXISTS import_corrections(request_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,signature TEXT NOT NULL,action TEXT NOT NULL,snapshot JSONB NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);}
export function importCorrectionReason(o){
 if(!o||!['tender','samples','amazon'].includes(o.channel)||!o.source_payload?.row||o.source_payload.erplainImported)return 'Cette action est réservée aux commandes importées depuis un fichier.';
 if(o.archived||o.source_payload?.importCorrection?.cancelled)return 'Cette commande importée est déjà annulée ou archivée.';
 if(o.partial_mode||o.erp_live?.bc?.id||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id||o.erp_test?.bc?.id||o.erp_test?.bl?.id||o.erp_test?.stockDocument?.id)return 'Un document Erplain existe : correction de l’import interdite.';
 if(o.erp_live?.customer?.id)return 'Un client Erplain a déjà été créé : rapprochement nécessaire avant remplacement.';
 if(['shipped','delivered','in_transit','cancelled'].includes(o.tracking_status))return 'Le statut de la commande interdit cette action.';
 return null;
}
export function importRevision(o,lines){return hash([o.reference,o.source_reference,o.channel,o.source_payload,o.address,o.recipient,o.source_date,lines.map(l=>[l.source_line,l.source_sku,String(l.quantity),l.source_payload])]);}
export function importCorrections(db,api,{parse=parseOrders,lock=withShipmentLock}={}){
 async function local(tx,id,locked=false){
  const suffix=locked?' FOR UPDATE':'';
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1'+suffix,[id])).rows[0];
  let reason=importCorrectionReason(o);if(reason)return {order:o,reason};
  const jobs=await Promise.all(['erp_live_jobs','carrier_jobs','resolution_jobs','correction_jobs','jobs'].map(t=>tx.query('SELECT status FROM '+t+' WHERE order_id=$1'+suffix,[id])));
  if(jobs.some(r=>r.rows.some(j=>active.includes(j.status)))||jobs[1].rows.some(j=>['pending','review','ready'].includes(j.status)))reason='Un traitement est actif ou un résultat transporteur reste à rapprocher.';
  const counts=await tx.query(`SELECT (SELECT count(*) FROM carrier_documents WHERE order_id=$1)+(SELECT count(*) FROM labels WHERE order_id=$1 AND tracking NOT LIKE 'SIM-%')+(SELECT count(*) FROM partial_deliveries WHERE order_id=$1) AS count`,[id]);
  if(Number(counts.rows[0].count))reason='Une étiquette ou une livraison existe : correction de l’import interdite.';
  const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line'+suffix,[id])).rows;
  const simulatedLabels=(await tx.query("SELECT * FROM labels WHERE order_id=$1 AND tracking LIKE 'SIM-%'"+suffix,[id])).rows;
  return {order:o,lines,simulatedLabels,reason,revision:importRevision(o,lines)};
 }
 async function absent(o){
  const company=await api.verify();if(Number(company.id)!==100174)throw Error('Société Erplain inattendue');
  const refs=[...new Set([o.reference,o.source_reference,'V3:'+o.id].filter(Boolean))];
  const where={OR:refs.map(value=>({column:'EXTERNAL_REFERENCE',operator:'EQ',value}))};
  const r=await api.request('query ImportCorrectionAbsence($bc:QueryOrdersWhereWhereConditions,$bl:QueryShippingOrdersWhereWhereConditions){Orders(first:100,where:$bc){data{id label} paginatorInfo{hasMorePages}} ShippingOrders(first:100,where:$bl){data{id label} paginatorInfo{hasMorePages}}}',{bc:where,bl:where});
  for(const key of ['Orders','ShippingOrders']){const c=r[key];if(!Array.isArray(c?.data)||c.paginatorInfo?.hasMorePages!==false)throw Error('Lecture Erplain incomplète : action interdite');if(c.data.length)throw Error('Un document existe dans Erplain ('+c.data.map(x=>x.label).join(', ')+') : action interdite');}
 }
 function ensure(s){if(s.reason)throw Error(s.reason);}
 function file(b){if(typeof b.content!=='string'||!b.content||b.content.length>24000000||typeof b.filename!=='string'||!b.filename.toLowerCase().endsWith('.xlsx'))throw Error('Sélectionnez un fichier Excel XLSX corrigé.');const bytes=Buffer.from(b.content,'base64');if(!bytes.length)throw Error('Fichier vide');return bytes;}
 async function replacement(o,b){
  const parsed=await parse(file(b),b.filename,o.channel),ref=o.source_reference||o.reference;
  const matches=parsed.valid.filter(x=>x.reference===ref);
  if(matches.length!==1||matches[0].visibilityHold||!matches[0].lines.length||parsed.errors.some(e=>e.reference===ref))throw Error('Commande '+ref+' absente, ambiguë ou invalide dans le fichier corrigé.');
  return {...matches[0],ignoredOrders:Math.max(0,parsed.valid.length-1)};
 }
 const summary=o=>({reference:o.reference,recipient:o.recipient,date:o.source_date,notes:o.source_payload?.notes||'',lines:o.lines.map(l=>({sku:l.source_sku,quantity:l.quantity,prixHT:l.source_payload?.puht??l.source_payload?.prixunitaireht??l.source_payload?.prix,tvaPercent:l.source_payload?.taxes,totalTTC:l.source_payload?.total}))});
 async function context(id){const s=await local(db,id);return {eligible:!s.reason,reason:s.reason,reference:s.order?.source_reference||s.order?.reference,revision:s.revision};}
 async function preview(b){return lock(()=>db.transaction(async tx=>{const s=await local(tx,b.id,true);ensure(s);await absent(s.order);const n=await replacement(s.order,b);return {revision:s.revision,before:summary({...s.order,lines:s.lines}),after:summary(n),ignoredOrders:n.ignoredOrders};}));}
 async function apply(b,user){
  if(!['replace','cancel'].includes(b.action)||!/^[a-f0-9-]{36}$/i.test(b.requestId||'')||b.confirmed!==true)throw Error('Validation explicite requise');
  const signature=hash([b.id,b.action,b.revision,b.reference,b.filename,b.content?hash(b.content):null]);
  return lock(()=>db.transaction(async tx=>{
   await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[b.id]);
   const prior=(await tx.query('SELECT * FROM import_corrections WHERE request_id=$1',[b.requestId])).rows[0];
   if(prior){if(prior.signature!==signature)throw Error('Cette validation a déjà été utilisée pour une autre action.');return {...prior.result,replayed:true};}
   const s=await local(tx,b.id,true);ensure(s);if(s.revision!==b.revision)throw Error('La commande a changé : rechargez l’aperçu avant validation.');
   if(b.reference!==(s.order.source_reference||s.order.reference))throw Error('Référence de confirmation incorrecte');
   await absent(s.order);const now=new Date().toISOString();let result;
   if(b.action==='replace'){
    const n=await replacement(s.order,b);
    const payload={...n.source_payload,importCorrection:{requestId:b.requestId,replacedAt:now,filename:b.filename,user:user.email}};
    await tx.query("DELETE FROM labels WHERE order_id=$1 AND tracking LIKE 'SIM-%'",[b.id]);
    await tx.query('DELETE FROM lines WHERE order_id=$1',[b.id]);
    for(const l of n.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[l.id,b.id,l.source_line,l.source_sku,l.quantity,JSON.stringify(l.source_payload)]);
    await tx.query("UPDATE orders SET recipient=$2,address=$3,source_date=$4,source_payload=$5,erp_live='{}',erp_status='live_review',label_status='blocked',issue='Excel corrigé : reprendre les contrôles',resolution_pending_resume=true,weight_kg=null,parcel_count=null,label_override=false WHERE id=$1",[b.id,n.recipient,JSON.stringify(n.address),n.source_date,JSON.stringify(payload)]);
    await tx.query("UPDATE erp_live_jobs SET status='review',error='Excel corrigé : reprendre les contrôles',updated_at=now() WHERE order_id=$1",[b.id]);
    await tx.query("UPDATE jobs SET status='blocked',error='Excel corrigé : reprendre les contrôles' WHERE order_id=$1",[b.id]);
    result={id:b.id,action:'replace',message:'Données Excel remplacées sur la même commande. Reprenez les contrôles avant création du BC.'};
   }else{
    const payload={...s.order.source_payload,importCorrection:{requestId:b.requestId,cancelled:true,cancelledAt:now,scope:'import_only_not_marketplace',user:user.email}};
    await tx.query("UPDATE orders SET source_reference=coalesce(source_reference,reference),reference=coalesce(source_reference,reference)||' / import annulé '||id,source_payload=$2,archived=true,erp_status='cancelled',label_status='cancelled',tracking_status='cancelled',resolution_pending_resume=true,issue='Commande importée annulée dans V3' WHERE id=$1",[b.id,JSON.stringify(payload)]);
    for(const t of ['erp_live_jobs','jobs'])await tx.query("UPDATE "+t+" SET status='cancelled',error='Commande importée annulée dans V3' WHERE order_id=$1",[b.id]);
    result={id:b.id,action:'cancel',message:'Commande importée annulée dans V3. Historique conservé ; aucune annulation dans la plateforme source ou Erplain.'};
   }
   await tx.query('INSERT INTO import_corrections(request_id,order_id,signature,action,snapshot,result) VALUES($1,$2,$3,$4,$5,$6)',[b.requestId,b.id,signature,b.action,JSON.stringify({order:s.order,lines:s.lines,simulatedLabels:s.simulatedLabels}),JSON.stringify(result)]);return result;
  }));
 }
 return {context,preview,apply};
}
