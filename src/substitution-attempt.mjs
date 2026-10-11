import {createHash} from 'node:crypto';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail=()=>{throw Error('Remplacement interrompu : relire le BC et rapprocher la demande enregistrée avant toute nouvelle écriture.');};
export function readSubstitutionAttempt(failed,order){
 const a=failed?.payload?.substitutionAttempt;
 if(!a||failed.status==='complete')return null;
 const b=failed.payload,p=a.plan;
 if(a.version!==1||!['mutation_started','local_committed'].includes(a.phase)||a.orderId!==order.id||a.requestId!==b.requestId||b.id!==order.id||b.confirmEquivalent!==true||a.fingerprint!==b.previewFingerprint||a.planHash!==digest(p)||p?.previewFingerprint!==a.fingerprint||String(p.bcId)!==String(order.erp_live?.bc?.id)||p.commercialBefore?.update_stock!==false||p.partialProof||p.historicalStockProof||p.originalSku!==b.sku||p.replacementSku!==b.replacementSku||Number(p.replaceQuantity)!==Number(b.replaceQuantity)||Number(p.replacementQuantity)!==Number(b.replacementQuantity))return fail();
 return a;
}
export function substitutionMappingSnapshot(rows){return rows.map(r=>({source_sku:r.source_sku,target_sku:r.mapped_sku??null,source_qty:r.mapping_source_qty==null?null:Number(r.mapping_source_qty),target_qty:r.mapping_target_qty==null?null:Number(r.mapping_target_qty)})).sort((a,b)=>a.source_sku<b.source_sku?-1:a.source_sku>b.source_sku?1:0);}
export async function startSubstitutionAttempt(db,order,b,plan,permanent,mappingLines=[]){
 if(!b.requestId||b.id!==order.id||b.confirmEquivalent!==true)return fail();
 const attempt={version:1,phase:'mutation_started',orderId:order.id,requestId:b.requestId,fingerprint:b.previewFingerprint,plan,planHash:digest(plan),permanent,mappingBefore:substitutionMappingSnapshot(mappingLines),startedAt:new Date().toISOString()};
 const saved=await db.query("UPDATE resolution_jobs SET payload=payload||jsonb_build_object('substitutionAttempt',$3::jsonb),updated_at=now() WHERE order_id=$1 AND request_id=$2 AND action='replace-equivalent' AND status='running' AND payload->>'previewFingerprint'=$4 AND payload->>'confirmEquivalent'='true' RETURNING id",[order.id,b.requestId,JSON.stringify(attempt),b.previewFingerprint]);
 if(saved.rows.length!==1)throw Error('Journal du remplacement non enregistré : aucune modification Erplain effectuée.');
 return attempt;
}
export async function finishSubstitutionAttempt(tx,orderId,requestId,attempt,result){
 const saved=await tx.query("UPDATE resolution_jobs SET payload=payload||jsonb_build_object('substitutionAttempt',$3::jsonb),status='waiting',stage='Équivalent enregistré · contrôle stock et BL',result=$4::jsonb,error=null,updated_at=now() WHERE order_id=$1 AND request_id=$2 AND action='replace-equivalent' AND status='running' RETURNING id",[orderId,requestId,JSON.stringify({...attempt,phase:'local_committed',completedAt:new Date().toISOString(),completionResult:result}),JSON.stringify({...result,equivalent:true})]);
 if(saved.rows.length!==1)throw Error('Fin du remplacement non enregistrée : synchronisation locale annulée, BC à rapprocher.');
 if(result.importDeferred)await tx.query("UPDATE resolution_jobs SET status='complete',stage='Remplacement enregistré · autres lignes de l’import en attente' WHERE order_id=$1 AND request_id=$2 AND action='replace-equivalent' AND status='waiting'",[orderId,requestId]);
}
