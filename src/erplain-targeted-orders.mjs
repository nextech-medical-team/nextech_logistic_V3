import {usesRecordedBc} from './existing-bc-execution.mjs';
import {recoveredPreparationIssue} from './recovered-preparation-issue.mjs';
import {completeShippingOrders} from './erplain-document-read.mjs';
import {erplainWeightKg} from './erplain-readonly.mjs';
import {importedLabelMissingFields} from './erplain-label-required.mjs';
import {recoveryScope,recoveredPendingScope,scopeSnapshot} from './erplain-pending-scope.mjs';
import {manualOrderFields,manualImportIssue} from './manual-erplain-orders.mjs';
import {manualReviewHash,queueManualReview} from './erplain-manual-validation.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

export function targetedReference(value){
 if(typeof value!=='string'||!value.trim()||value.trim().length>200||/[\r\n;]/.test(value))throw Error('Saisir un seul numéro de BC ou une référence externe non vide');
 return value.trim();
}
export function assertDocumentRead(d,id){
 if(!d||!d.id||id&&String(d.id)!==String(id)||!d.label||!d.status||!Array.isArray(d.line_items))throw Error('API Erplain · BC ou lignes non reçus');
 if(!Array.isArray(d.shipping_orders?.data)||d.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Liste des BL incomplète : récupération bloquée');
 if(d.shipping_orders.data.some(b=>!b.id||!b.status))throw Error('API Erplain · Identité ou statut des BL incomplets');
}
export function documentIssues(d,existingOrder=null){
 const admission=[],preparation=[],issue=manualImportIssue(d);let scope;try{scope=existingOrder?recoveredPendingScope(d,existingOrder):recoveryScope(d);}catch(e){preparation.push(e.message);scope=recoveryScope(d);}if(scope.preparationIssue)preparation.push(scope.preparationIssue);const lines=scope.lines;
 const selectedIssue=scope.scoped?manualImportIssue({...d,line_items:scope.lines}):issue;if(selectedIssue)admission.push(selectedIssue);
 if(d.status!=='active')preparation.push('BC Erplain '+d.status+' : activer le BC avant préparation');
 if(!d.customer?.id)admission.push('Client Erplain absent');
 if(!d.currency?.label||d.total==null||!Number.isFinite(Number(d.total))||d.line_items?.some(l=>l.tax_amount==null||!Number.isFinite(Number(l.tax_amount))))admission.push('Montants, taxes ou devise Erplain incomplets');
 const seen=new Map();
 for(const l of lines){const v=l.variant;
  if(!v?.id||v.active===false||v.product?.active===false)admission.push((v?.sku||l.label||'Produit')+' · Produit absent ou inactif');
  if(!l.id||l.price==null||!Number.isFinite(Number(l.price))||Number(l.price)<0)admission.push((v?.sku||'Produit')+' · Identité de ligne ou prix invalide');
  if(v?.sku&&seen.has(v.sku)&&seen.get(v.sku)!==String(v.id))admission.push(v.sku+' · Plusieurs produits Erplain pour ce SKU');
  if(v?.sku)seen.set(v.sku,String(v.id));
  if(!l.location?.id)preparation.push((v?.sku||'Produit')+' · Emplacement de stock manquant');
  if(l.shipped_quantity==null||!Number.isFinite(Number(l.shipped_quantity)))preparation.push((v?.sku||'Produit')+' · Quantité déjà expédiée non reçue');
  if(v?.track_inventory!==false&&v?.track_inventory!==true)preparation.push((v?.sku||'Produit')+' · Politique de stock non reçue');
  try{erplainWeightKg(v?.weight_amount,v?.weight_unit);}catch{preparation.push((v?.sku||'Produit')+' · Poids à vérifier');}
 }
 const bls=(scope.scoped?scope.pending:d.shipping_orders?.data||[]).filter(b=>b.status!=='cancelled');
 if(bls.length>1)preparation.push('Plusieurs BL : choisir la livraison dans le circuit des livraisons partielles');
 if(!scope.scoped&&(bls.some(b=>['shipped','delivered'].includes(b.status))||lines.some(l=>Number(l.shipped_quantity)>0)))preparation.push('Commande déjà expédiée en totalité ou en partie : utiliser les livraisons partielles');
 if(!['label','address_1','postal_code','city','country'].every(k=>String(d.shipping_address?.[k]||'').trim()))preparation.push('Adresse de livraison à compléter');
 try{assertFullOrderStock(lines,{preserveInstalled:true});}catch(e){preparation.push(e.message);}
 return {admissionIssues:[...new Set(admission)],preparationIssues:[...new Set(preparation)]};
}
export async function initializeTargetedOrders(db){await db.exec(`CREATE TABLE IF NOT EXISTS erplain_order_identity(account TEXT NOT NULL CHECK(account='live'),bc_id TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),PRIMARY KEY(account,bc_id),UNIQUE(account,order_id));`);}
export async function existingBcOrder(db,bcId){
 const rows=(await db.query("SELECT o.* FROM orders o WHERE (o.erp_live->'bc'->>'id'=$1 AND NOT (coalesce(o.source_payload->>'erplainImported','false')='true' AND coalesce(o.source_payload->>'account','')<>'live')) OR o.id IN (SELECT order_id FROM erplain_order_identity WHERE account='live' AND bc_id=$1)",[String(bcId)])).rows;
 if(rows.length>1)throw Error('Ce BC est déjà associé à plusieurs commandes V3 : rapprochement requis');
 return rows[0]||null;
}
export async function synchronizeRecoveredOrder(db,o,d){
 const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status IN ('queued','creating_bl','publishing_bl','creating_stock','finalizing_bl','creating_label')",[o.id])).rows.length;
 if(busy)return ['Traitement en cours : données Erplain consultées, actualisation de la commande différée'];
 const issued=(await db.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (result IS NOT NULL OR tracking<>'[]'::jsonb OR status IN ('ready','review'))",[o.id])).rows.length;
 const local=(await db.query('SELECT * FROM lines WHERE order_id=$1',[o.id])).rows;
 const totals=rows=>{const m=new Map();for(const l of rows){const k=(l.variant?.sku||l.target_sku)+':'+String(l.variant?.id||l.source_payload?.erplainVariantId||'');m.set(k,(m.get(k)||0)+Number(l.variant?l.quantity:l.target_quantity));}return JSON.stringify([...m].sort());};
 const issues=documentIssues(d,o),problems=[...issues.admissionIssues,...issues.preparationIssues];
 let scope;try{scope=recoveredPendingScope(d,o);}catch(e){problems.push(e.message);}
 const partials=(await db.query("SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status<>'cancelled'",[o.id])).rows.length;
 if(scope?.scoped&&!issued&&!partials&&!o.partial_mode&&!o.archived&&o.source_payload?.erplainImported&&o.source_payload?.account==='live'){
  // Reconcile only after a human reread; never replace issued or engaged shipments.
  for(const line of scope.lines){
   const matches=local.filter(l=>String(l.source_payload?.erplainVariantId)===String(line.variant.id)&&String(l.source_line)===String(line.id));
   if(matches.length!==1)throw Error('Lignes locales à rapprocher avant récupération du BL en attente');
   await db.query('UPDATE lines SET quantity=$2,target_quantity=$2 WHERE id=$1',[matches[0].id,line.quantity]);
  }
  const keep=scope.lines.map(l=>String(l.id));
  for(const line of local)if(!keep.includes(String(line.source_line)))await db.query('DELETE FROM lines WHERE id=$1',[line.id]);
  const state={...o.erp_live,bc:scopeSnapshot(d,scope),pendingBlIds:scope.pending.map(b=>String(b.id))};
  if(scope.pending.length===1){
   if(state.bl?.id&&String(state.bl.id)!==String(scope.pending[0].id)&&state.stockDocument?.id)throw Error('Sortie de stock associée à un autre BL : rapprochement requis');
   state.bl=scope.pending[0];
  }
  delete state.stockCheckedAt;delete state.verifiedAt;delete state.labelPreparationFingerprint;
  await db.query("UPDATE orders SET erp_live=$2::jsonb,issue=$3,resolution_pending_resume=true WHERE id=$1",[o.id,JSON.stringify(state),recoveredPreparationIssue(o,state)]);
  for(const line of local){const chosen=scope.lines.find(l=>String(l.id)===String(line.source_line));if(chosen)line.target_quantity=chosen.quantity;}
  for(let i=local.length-1;i>=0;i--)if(!keep.includes(String(local[i].source_line)))local.splice(i,1);
 }

 if(!usesRecordedBc(o)&&totals(local)!==totals(scope?.lines||shippingProductLines(d.line_items)))problems.push('BC Erplain modifié : produits ou quantités différents des données validées dans V3');
 const a=d.shipping_address||{},address={...o.address,name:a.label||d.customer?.label||o.recipient,street:[a.address_1,a.address_2].filter(Boolean).join(' '),postal:a.postal_code||'',city:a.city||'',country:a.country||'',phone:a.phone||''};
 if(issued&&['name','street','postal','city','country','phone'].some(k=>String(address[k]||'')!==String(o.address[k]||'')))problems.push('Adresse Erplain modifiée : étiquette existante à vérifier');
 const messages=(o.erp_live.stockDocument?.id||d.update_stock===true)?problems.filter(p=>!/stock insuffisant/i.test(p)):problems;
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc}',$2::jsonb),erplain_refresh=erplain_refresh||$3::jsonb,resolution_pending_resume=CASE WHEN NOT $4 AND NOT archived THEN true ELSE resolution_pending_resume END WHERE id=$1",[o.id,JSON.stringify(scope?scopeSnapshot(d,scope):d),JSON.stringify({issues:[...new Set(messages)],at:new Date().toISOString(),account:'live'}),Boolean(issued)]);
 if(!issued&&!o.partial_mode&&!o.archived&&address.street&&address.country){
  await db.query('UPDATE orders SET address=$2,recipient=$3 WHERE id=$1',[o.id,JSON.stringify({...address,street1:a.address_1||'',street2:a.address_2||''}),d.customer?.label||o.recipient]);
  // Only retire a definite preflight rejection, never a carrier creation with
  // uncertain outcome, tracking, response or documents. Preserve its audit.
  const old=(await db.query("SELECT error FROM carrier_jobs c WHERE c.order_id=$1 AND c.status='failed' AND c.creation_started_at IS NULL AND coalesce(c.failure_phase,'preflight')='preflight' AND c.result IS NULL AND c.reference IS NULL AND coalesce(c.tracking,'[]'::jsonb)='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM carrier_documents x WHERE x.order_id=c.order_id)",[o.id])).rows[0];
  const prefix='Erplain LIVE · Informations obligatoires manquantes : ';
  if(old?.error?.startsWith(prefix)){
   const selected=scope?.pending?.find(b=>String(b.id)===String(o.erp_live?.bl?.id))||d.shipping_orders?.data?.find(b=>String(b.id)===String(o.erp_live?.bl?.id));
   const missing=importedLabelMissingFields(d,selected||o.erp_live?.bl||{}),next=missing.length?prefix+missing.join(', '):null;
   if(next!==old.error){
    await db.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.label_preflight_refreshed',$1)",[JSON.stringify({orderId:o.id,previousError:old.error,currentError:next,labelPurchased:false})]);
    await db.query("UPDATE carrier_jobs SET error=$2,original_error=coalesce(original_error,error),failure_phase='preflight',updated_at=now() WHERE order_id=$1 AND status='failed' AND error=$3 AND creation_started_at IS NULL AND coalesce(failure_phase,'preflight')='preflight' AND result IS NULL AND reference IS NULL AND coalesce(tracking,'[]'::jsonb)='[]'::jsonb AND NOT EXISTS(SELECT 1 FROM carrier_documents x WHERE x.order_id=carrier_jobs.order_id)",[o.id,next,old.error]);
   }
  }
 }
 return [...new Set(messages)];
}
export function targetedOrderService(db,api){
 async function read(id){await api.verify();const {Order:d}=await api.request(`query V3TargetedRead($id:ID!){Order(id:$id){${manualOrderFields}}}`,{id:String(id)});if(d&&String(d.id)===String(id))await completeShippingOrders(api,d);assertDocumentRead(d,id);return d;}
 async function preview(id){
  const d=await read(id);
  return withShipmentLock(()=>db.transaction(async tx=>{
   const existing=await existingBcOrder(tx,id),r=(await tx.query('SELECT * FROM erplain_manual_review WHERE bc_id=$1',[String(id)])).rows[0];
   await tx.query("INSERT INTO erplain_refresh_cache(account,section,entity_id,reference,detail) VALUES('live','orders',$1,$2,$3) ON CONFLICT(account,section,entity_id) DO UPDATE SET reference=excluded.reference,detail=excluded.detail,missing=false,seen_at=now()",[String(id),d.external_reference||d.label,JSON.stringify(d)]);
   if(existing&&r?.status!=='pending'){
    const issues=documentIssues(d,existing),messages=await synchronizeRecoveredOrder(tx,existing,d);
    return {document:d,...issues,preparationIssues:messages,alreadyRecovered:true,orderId:existing.id,archived:existing.archived,readAt:new Date().toISOString()};
   }
   if(r&&r.status!=='pending')throw Error('Ce BC a fait l’objet d’un refus ou d’une annulation : vérifier son historique');
   await queueManualReview(tx,d,existing?.id||null);
   const duplicate=(await tx.query('SELECT id FROM orders WHERE reference=$1 AND id IS DISTINCT FROM $2 LIMIT 1',[String(d.external_reference||d.label).trim(),existing?.id||null])).rows.length;
   const issues=documentIssues(d);if(duplicate)issues.admissionIssues.push('Référence déjà présente dans V3 : rapprochement requis');
   return {document:d,reviewHash:manualReviewHash(d),...issues,readAt:new Date().toISOString()};
  }));
 }
 return {
  async lookup(b){
   const reference=targetedReference(b.reference);if(b.bcId!==undefined&&(typeof b.bcId!=='string'||!b.bcId.trim()||b.bcId.length>100))throw Error('Sélectionner un seul BC');
   await api.verify();const matches=new Map();let page=1;
   for(;;){const r=await api.request('query V3TargetedLookup($page:Int!,$where:QueryOrdersWhereWhereConditions!){Orders(first:100,page:$page,where:$where){data{id label external_reference customer{id label} status} paginatorInfo{hasMorePages}}}',{page,where:{OR:[{column:'LABEL',operator:'EQ',value:reference},{column:'EXTERNAL_REFERENCE',operator:'EQ',value:reference}]}});
    if(!Array.isArray(r.Orders?.data)||typeof r.Orders.paginatorInfo?.hasMorePages!=='boolean')throw Error('API Erplain · Liste des BC incomplète');
    for(const d of r.Orders.data){if(!d.id||!d.label)throw Error('API Erplain · Identité de BC incomplète');if(d.label===reference||d.external_reference===reference)matches.set(String(d.id),d);}
    if(!r.Orders.paginatorInfo.hasMorePages)break;if(++page>5)throw Error('Trop de correspondances : saisir le numéro exact du BC');
   }
   const candidates=[...matches.values()];if(!candidates.length)return {notFound:true,candidates:[],reference};
   if(b.bcId&&!matches.has(b.bcId))throw Error('Le BC sélectionné ne correspond plus à la référence saisie');
   if(!b.bcId&&candidates.length>1)return {selectionRequired:true,candidates,reference};
   return {...await preview(b.bcId||String(candidates[0].id)),reference};
  },
  async reread(b){if(typeof b.bcId!=='string'||!b.bcId.trim())throw Error('BC requis');const r=(await db.query('SELECT bc_id FROM erplain_manual_review WHERE bc_id=$1',[b.bcId])).rows[0];if(!r)throw Error('Récupérer ce BC avant de le relire');return preview(b.bcId);},
  async list({search='',page=1}={}){
   page=Math.max(1,Math.min(10000,Number(page)||1));
   const where="o.source_payload->>'erplainImported'='true' AND o.source_payload->>'account'='live' AND (o.reference ILIKE $1 OR o.erp_live->'bc'->>'label' ILIKE $1 OR o.recipient ILIKE $1)";
   const params=['%'+String(search).slice(0,200)+'%'];const total=Number((await db.query('SELECT count(*) n FROM orders o WHERE '+where,params)).rows[0].n);
   const rows=(await db.query(`SELECT o.id,o.reference,o.recipient,o.archived,o.partial_mode,o.source_payload,o.erp_live,o.issue,o.erplain_refresh,o.label_status,o.tracking_status,greatest((o.erplain_refresh->>'manualCheckedAt')::timestamptz,c.seen_at) AS read_at,r.status AS validation_status,EXISTS(SELECT 1 FROM carrier_jobs j WHERE j.order_id=o.id AND (j.result IS NOT NULL OR j.tracking<>'[]'::jsonb OR j.status IN ('pending','creating','awaiting_pdf','ready','review'))) AS has_label,EXISTS(SELECT 1 FROM resolution_jobs j WHERE j.order_id=o.id AND j.status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs j WHERE j.order_id=o.id AND j.status IN ('pending','processing')) AS busy FROM orders o LEFT JOIN erplain_refresh_cache c ON c.account='live' AND c.section='orders' AND c.entity_id=o.erp_live->'bc'->>'id' LEFT JOIN erplain_manual_review r ON r.bc_id=o.erp_live->'bc'->>'id' WHERE ${where} ORDER BY o.received_at DESC,o.id LIMIT 25 OFFSET $2`,[...params,(page-1)*25])).rows;
   for(const row of rows){const d=documentIssues(row.erp_live.bc||{},row);row.preparationIssues=[...d.admissionIssues,...d.preparationIssues];if(row.has_label||row.erp_live.stockDocument?.id||row.erp_live.bc?.update_stock===true)row.preparationIssues=row.preparationIssues.filter(p=>!/stock insuffisant/i.test(p));}
   return {rows,total,page,pages:Math.max(1,Math.ceil(total/25))};
  }
 };
}
