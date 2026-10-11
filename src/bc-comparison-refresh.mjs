import {bcAuthorityIdentityMatches} from './erplain-bc-line-authority.mjs';
import {bcComparisonDiagnostic} from './resolution-bc-diagnostic.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';
import {mappingSelectionFingerprint} from './current-mapping-line.mjs';
export const physicalComparisonErrors=Object.freeze([
 'Commande V3 et BC différents : comparer les produits et quantités avant de générer l’étiquette',
 'Commande V3 et BC différents : vérifier les produits et quantités avant reprise',
 'Commande V3 et BC différents : vérifier les quantités avant dérogation',
 'BC · Produits ou quantités des lignes Erplain différents de la source',
 'Produits ou quantités V3 et BC différents : vérifier les unités, conditionnements et documents avant toute reprise',
 'Écart entre la commande partielle et le BC complet : vérifier le périmètre des livraisons et les unités'
]);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function documentReadVersion(order){return JSON.stringify(canonical({bc:order.erp_live?.bc,bl:order.erp_live?.bl,stockDocument:order.erp_live?.stockDocument,documentSource:order.erp_live?.documentSource,partialSource:order.erp_live?.partialSource,comparison:order.erp_live?.bcComparisonRefresh,authority:order.erp_live?.bcLineAuthority,partial_mode:order.partial_mode,imported:order.source_payload?.erplainImported}));}
export function assertRefreshedBcDocument(order,bc){
 bcComparisonDiagnostic(order,bc,[]);
 for(const line of bc.line_items.filter(l=>l.variant)){const q=line.quantity;if(!((typeof q==='number'||typeof q==='string'&&q.trim()!=='')&&Number.isFinite(Number(q))&&Number(q)>=0))throw Error('Erplain · Quantité BC non confirmée : aucune projection remplacée');}
}
// Only reconcile the exact physical diagnostic. Never resume or complete a job.
export async function reconcileRefreshedBcDiagnostics(tx,id,bc){
 const order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!order)throw Error('Commande V3 introuvable pendant comparaison');
 await assertDocumentIdle(tx,id);
 const lines=(await tx.query('SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku WHERE l.order_id=$1 FOR SHARE OF l',[id,order.channel])).rows;
 const invalid=lines.some(l=>{const values=l.target_quantity!=null?[l.target_quantity]:(l.source_qty!=null||l.target_qty!=null)?[l.quantity,l.source_qty,l.target_qty]:[l.quantity];return values.some(v=>!((typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v))&&Number(v)>0));});
 const diagnostic=bcComparisonDiagnostic(order,bc,lines);
 if(invalid){diagnostic.comparison=null;diagnostic.errors.push({code:'comparison_unconfirmed',message:'Quantités source ou ratio non confirmés : diagnostic conservé'});}
 const checkedAt=new Date().toISOString();
 const proof={checkedAt,bcId:String(bc.id),comparison:diagnostic.comparison,errors:diagnostic.errors,...(!invalid&&diagnostic.comparison?{mappingFingerprint:mappingSelectionFingerprint(lines,order.channel)}:{}),readOnly:true,preparationNotStarted:true};
 const concordant=bc.status==='active'&&diagnostic.comparison?.different===false&&diagnostic.errors.length===0;
 const difference=diagnostic.comparison?.different===true;
 const text=rows=>(rows||[]).map(([sku,quantity])=>sku+' × '+quantity).join(', ');
 const currentError=concordant?null:difference?'BC · Produits ou quantités des lignes Erplain différents de la source : V3 ['+text(diagnostic.comparison.expected)+'] / BC ['+text(diagnostic.comparison.observed)+']':diagnostic.comparison===null?'Comparaison BC non confirmée : '+diagnostic.errors.map(e=>e.message).join(' ; '):undefined;
 const jobs=(await tx.query("SELECT id,error,result,action FROM resolution_jobs WHERE order_id=$1 AND status='review' FOR UPDATE",[id])).rows;
 const identityConfirmed=bcAuthorityIdentityMatches(order,bc,lines);
 let identityUnconfirmed=concordant&&!!order.erp_live?.bcLineAuthority&&!identityConfirmed;
 for(const job of jobs){
  const marker=job.result?.bcComparisonRefresh;
  const original=physicalComparisonErrors.includes(job.error)?job.error:marker&&physicalComparisonErrors.includes(marker.previousError)&&job.error===marker.currentError?marker.previousError:null;
  if(!original||currentError===undefined)continue;
  // A SKU comparison cannot certify the ERP variant identity used by pricing.
  // Only the explicit BC adoption can certify the refreshed variant identity.
  let jobError=currentError;
  if(concordant&&original==='BC · Produits ou quantités des lignes Erplain différents de la source'&&!identityConfirmed){identityUnconfirmed=true;if(!marker||job.error!=null)continue;jobError=original;}
  if(job.error===jobError&&job.action!=='compare-bc')continue;
  const previousResult=marker&&Object.hasOwn(marker,'previousResult')?marker.previousResult:job.result;
  const record={...(job.action==='compare-bc'?{bc:diagnostic.bc,lines:diagnostic.lines,comparison:diagnostic.comparison,errors:diagnostic.errors,message:diagnostic.message,provider:diagnostic.provider,readOnly:true,checkedAt}:{}),bcComparisonRefresh:{previousError:original,currentError:jobError,proof,...(job.action==='compare-bc'?{previousResult}:{})}};
  await tx.query("UPDATE resolution_jobs SET result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('previousResult',result) END)||$3::jsonb,error=$4,updated_at=now() WHERE id=$1 AND order_id=$2 AND status='review' AND error IS NOT DISTINCT FROM $5 RETURNING id",[job.id,id,JSON.stringify(record),jobError,job.error]);
 }
 if(identityUnconfirmed){proof.identityUnconfirmed=true;proof.errors=[...proof.errors,{code:'variant_identity_unconfirmed',message:'Identité variante ERP à recontrôler avant reprise'}];}
 await tx.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bcComparisonRefresh}',$2::jsonb,true) WHERE id=$1",[id,JSON.stringify(proof)]);
 return {...proof,concordant:concordant&&!identityUnconfirmed};
}
