import {chooseDocumentStockVariant} from './document-stock-choice.mjs';
// Pure proposal: supplier reads are supplied by the caller. No database, HTTP,
// catalogue write, document creation or preparation continuation occurs here.
export function catalogueLookupProof({sku,response,locationId,document,readAt}){
 if(typeof sku!=='string'||!sku.trim()||sku!==sku.trim())throw Error('SKU exact requis pour la preuve catalogue');
 const variants=response?.Variants;
 if(!Array.isArray(variants?.data)||variants.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Réponse catalogue incomplète');
 if(!Number.isFinite(Date.parse(readAt)))throw Error('Date de lecture catalogue requise');
 if(variants.data.some(v=>v?.sku!==sku))throw Error('API Erplain · Recherche produit incohérente');
 const base={sku,readAt,sourceReadOnly:true,complete:true,candidateIds:variants.data.map(v=>String(v.id)),documentId:document?.id??null};
 if(!variants.data.length)return {...base,status:'missing'};
 if(variants.data.some(v=>typeof v.active!=='boolean'||typeof v.product?.active!=='boolean'||!v.id||!v.product?.id))throw Error('Identité ou activité produit non vérifiée');
 const active=variants.data.filter(v=>v.active===true&&v.product.active===true);
 if(!active.length)return {...base,status:'inactive'};
 const choice=chooseDocumentStockVariant(variants.data,{sku,locationId,document});
 return {...base,status:'active',variantId:String(choice.variant.id),productId:String(choice.variant.product.id),selectionReason:choice.reason};
}
export function reconcileCatalogueMessage(message,proof,{errorUpdatedAt,now=Date.now(),maxAgeMs=300000}={}){
 const at=Date.parse(proof?.readAt),errorAt=errorUpdatedAt instanceof Date?errorUpdatedAt.getTime():Date.parse(errorUpdatedAt);
 if(proof?.status!=='active'||proof.complete!==true||proof.sourceReadOnly!==true||!proof.variantId||!proof.productId||!Number.isFinite(at)||!Number.isFinite(errorAt)||at<=errorAt||at>now||now-at>maxAgeMs)return {message,retired:[]};
 const exact=new Set([`${proof.sku} : SKU Erplain introuvable`,`Création produit · Nom de la référence convertie à confirmer : ${proof.sku}`,`BC · SKU Erplain LIVE introuvable : ${proof.sku}`,`BC · SKU Erplain LIVE ambigu : ${proof.sku}`,`Référence Erplain absente ou ambiguë : ${proof.sku}`]);
 const retired=[],parts=String(message??'').split(/\s;\s/),kept=[];
 for(const part of parts){if(exact.has(part)){retired.push({previousMessage:part,proof});}else kept.push(part);}
 return retired.length?{message:kept.filter(Boolean).join(' ; ')||null,retired}:{message,retired};
}

// Local diagnostics only; caller supplies a complete fresh supplier proof.
// No product binding, weight/cache write, stock, document or preparation action.
export async function refreshLookupDiagnostics(db,order,proof){
 if(proof?.status!=='active'||proof.complete!==true||proof.sourceReadOnly!==true||typeof proof.sku!=='string'||!proof.sku.trim()||!/^\d+$/.test(String(proof.variantId||''))||!/^\d+$/.test(String(proof.productId||'')))throw Error('Preuve catalogue active complète requise');
 const retired=[];
 await db.transaction(async tx=>{
  const current=(await tx.query('SELECT id,archived,issue,erp_live FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
  if(!current||current.archived!==false)throw Error('Commande absente ou archivée : diagnostic conservé');
  const currentBc=String(current.erp_live?.bc?.id||''),previousBc=String(order.erp_live?.bc?.id||'');
  if(currentBc!==previousBc||currentBc!==String(proof.documentId||''))throw Error('Identité du BC modifiée : diagnostic conservé');
  const lines=(await tx.query(`SELECT CASE WHEN l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,l.source_sku) END sku FROM lines l JOIN orders o ON o.id=l.order_id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE l.order_id=$1`,[order.id])).rows;
  if(!lines.some(l=>l.sku===proof.sku))throw Error('SKU absent des lignes actuelles : diagnostic conservé');
  const job=(await tx.query('SELECT status,error,updated_at FROM erp_live_jobs WHERE order_id=$1 FOR UPDATE',[order.id])).rows[0];
  if(job&&['pending','processing'].includes(job.status))throw Error('Traitement Erplain actif : diagnostic conservé');
  const carrier=(await tx.query('SELECT status FROM carrier_jobs WHERE order_id=$1 FOR UPDATE',[order.id])).rows[0];
  if(carrier&&['pending','creating','awaiting_pdf'].includes(carrier.status))throw Error('Traitement transporteur actif : diagnostic conservé');
  // pg converts timestamptz to Date and drops microseconds. Keep the original
  // text for the conditional update and audit while holding the row lock.
  const resolutions=(await tx.query('SELECT id,action,status,error,updated_at::text AS updated_at FROM resolution_jobs WHERE order_id=$1 ORDER BY created_at DESC FOR UPDATE',[order.id])).rows;
  if(resolutions.some(j=>j.action!=='check-sku'&&['queued','running','waiting'].includes(j.status)))throw Error('Résolution active : diagnostic conservé');
  const latest=resolutions.find(j=>!['refresh','check-sku'].includes(j.action));
  const resolution=latest?.status==='review'?latest:null;
  const bareSkuMessage=`${proof.sku} : SKU Erplain introuvable`;
  const hasBare=text=>String(text??'').split(/\s;\s/).includes(bareSkuMessage);
  const orderDate=hasBare(current.issue)?(hasBare(resolution?.error)?resolution.updated_at:null):job?.status==='review'?job.updated_at:null;
  const scopes=[...(job?.status==='review'?[['erp',job.error,job.updated_at]]:[]),['order',current.issue,orderDate],...(resolution?[['resolution',resolution.error,resolution.updated_at]]:[])];
  for(const [scope,message,errorUpdatedAt] of scopes){
   const result=reconcileCatalogueMessage(message,proof,{errorUpdatedAt});
   if(!result.retired.length)continue;
   const updated=scope==='erp'
    ?await tx.query("UPDATE erp_live_jobs SET error=$2 WHERE order_id=$1 AND status='review' AND error=$3",[order.id,result.message,job.error])
    :scope==='resolution'
     ?await tx.query("UPDATE resolution_jobs SET error=$2 WHERE id=$1 AND status='review' AND error=$3 AND updated_at=$4",[resolution.id,result.message,resolution.error,resolution.updated_at])
     :await tx.query('UPDATE orders SET issue=$2 WHERE id=$1 AND issue=$3',[order.id,result.message,current.issue]);
   if(updated.rowCount!==1)throw Error('Diagnostic modifié pendant le rapprochement : transaction annulée');
   retired.push(...result.retired.map(x=>({...x,scope,previousUpdatedAt:errorUpdatedAt,...(scope==='resolution'?{jobId:resolution.id,action:resolution.action,status:resolution.status}:{})})));
  }
  if(retired.length)await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','diagnostic.catalogue_lookup_reconciled',$1)",[JSON.stringify({orderId:order.id,proof,retired,preparationChanged:false})]);
 });
 return {provider:'Erplain',readOnly:true,diagnosticOnly:true,sourceReadOnly:true,localDiagnosticUpdates:retired.length>0,proof,retired,errors:[],message:retired.length?'Produit actif vérifié ; ancien diagnostic catalogue rapproché. La préparation reste à vérifier.':'Produit actif vérifié ; aucun ancien diagnostic catalogue modifié. La préparation reste à vérifier.'};
}
