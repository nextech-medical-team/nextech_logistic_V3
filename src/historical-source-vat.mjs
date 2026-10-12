import {usesRecordedBc} from './existing-bc-execution.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {bcAllowedSql} from './bc-authorization.mjs';
import {mutationBlock} from './erp-transient-policy.mjs';
import {currentResolutionState,resolutionStateSql} from './historical-preparation-completion.mjs';
import {alignmentFields} from './mapping-bc-alignment.mjs';
import {readHistoricalStock,assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';
import {verifyBcLineIdentity,verifyBcPricing} from './bc-pricing.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=l=>JSON.stringify([l.type||'normal',String(l.variant?.id||''),String(l.location?.id||''),Number(l.quantity)]);
const codes=l=>JSON.stringify((l.tax_codes||[]).map(t=>String(t.id)).sort());
const neutral=l=>l.type==='shipping_cost'&&Number(l.quantity)===1&&['price','tax_amount','discount','discount_rule_amount','ecotax'].every(k=>Object.hasOwn(l,k)&&(l[k]===null||l[k]!==''&&Number(l[k])===0));
export const sourceVatError='BC · Codes TVA Erplain différents de la source ; produits et quantités identiques';
export const sourceVatReviewErrors=[sourceVatError,'TVA source · Lignes ou emplacements ambigus'];
// Source shipping charges omit an inventory location. Match only a single
// non-product, unit shipping row; supplier identity remains strict on read-back.
const matchesSourceLine=(actual,expected)=>identity(actual)===identity(expected)||
 actual.type==='shipping_cost'&&expected.type==='shipping_cost'&&!actual.variant?.id&&!expected.variant?.id&&!expected.location?.id&&Number(actual.quantity)===1&&Number(expected.quantity)===1;
export function sourceVatResolutionState(actions=[]){
 const resume=actions.find(j=>['resume','resume-erp'].includes(j.action)&&j.status==='review'&&sourceVatReviewErrors.includes(j.error)&&j.result?.resume===true&&!j.result?.partialRemainder);
 const started=Date.parse(resume?.created_at),obsolete=[];
 const current=actions.filter(j=>{
  const previous=Date.parse(j.created_at);
  const superseded=j.action==='equivalent-preview'&&j.status==='review'&&j.result==null&&/stock insuffisant/.test(j.error||'')&&/Remplacement non enregistré\./.test(j.error||'')&&Number.isFinite(started)&&Number.isFinite(previous)&&previous<started;
  if(superseded)obsolete.push(j.id);
  return !superseded;
 });
 return {...currentResolutionState(current),obsoletePreviewIds:obsolete};
}
export function sourceVatResumeEligible(o){
 if(usesRecordedBc(o))return false;
 return o.channel==='temu'&&o.archived===false&&!o.partial_mode&&!mutationBlock(o,{allowHeldBc:true})&&o.erp_live?.phase==='historical_review'&&!!o.erp_live.bc?.id&&!o.erp_live.bl?.id&&!o.erp_live.sourceVatAttempt?.status?.includes('uncertain')&&!o.source_payload?.erplainImported&&!o.source_payload?.visibilityHold&&!o.source_payload?.erplainValidationHold&&sourceVatReviewErrors.includes(o.error);
}
// Bounded local scan; one normal resolution per source financial version.
// No external reads here, and no repeating an unchanged failed intervention.
export async function queueSourceVatReviews(db){
 await db.transaction(async tx=>{
  const rows=(await tx.query(`SELECT o.*,j.error FROM orders o JOIN erp_live_jobs j ON j.order_id=o.id
   WHERE j.status='review' AND j.error=ANY($1::text[]) AND (${bcAllowedSql}) AND o.channel='temu'
   AND o.erp_live->>'phase'='historical_review' AND o.erp_live->'bc'->>'id' IS NOT NULL
   AND o.erp_live->'bl'->>'id' IS NULL
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND (c.status IN ('queued','applying','checking','waiting') OR c.status='review' AND NOT EXISTS(SELECT 1 FROM correction_jobs n WHERE n.order_id=c.order_id AND (n.payload->>'action') IS NOT DISTINCT FROM (c.payload->>'action') AND (n.created_at,n.id)>(c.created_at,c.id))))
   ORDER BY j.updated_at LIMIT 10 FOR UPDATE OF o,j SKIP LOCKED`,[sourceVatReviewErrors])).rows;
  for(const o of rows){
   if(!sourceVatResumeEligible(o)||!o.source_payload?.temuAmounts?.data?.orderList?.length)continue;
   const state=sourceVatResolutionState((await tx.query(resolutionStateSql,[o.id])).rows);
   if(state.pendingReplacement||state.reviews.some(r=>!['resume','resume-erp'].includes(r.action)||!sourceVatReviewErrors.includes(r.error)))continue;
   const requestId='source-vat-v2-'+hash({order:o.id,bc:o.erp_live.bc.id,source:o.source_payload.temuAmounts.data});
   const id=randomUUID(),payload={id:o.id,requestId,action:'resume-erp',type:'historical-preparation',resumeAfter:true};
   const inserted=await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload) VALUES($1,$2,$3,'resume-erp',$4) ON CONFLICT(request_id) DO NOTHING RETURNING id",[id,o.id,requestId,JSON.stringify(payload)]);
   if(inserted.rows.length)await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','source_vat.continuation_requested',$1)",[JSON.stringify({orderId:o.id,bcId:o.erp_live.bc.id,resolutionId:id,authority:'current_source',labelsPreserved:true,obsoletePreviewIds:state.obsoletePreviewIds})]);
  }
 });
}

// Human rule: current source tax codes win. Never change an invoiced, paid or
// shipped document, and never infer permission to change products or stock.
export function sourceVatPlan(bc,o){
 if(usesRecordedBc(o))return null;
 if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.external_reference!==o.reference||bc.status!=='active'||typeof bc.update_stock!=='boolean')throw Error('TVA source · Identité BC non confirmée');
 if(!o.pricing?.items?.length||bc.tax_type!==o.pricing.tax_type||bc.currency?.label!==o.pricing.currency)throw Error('TVA source · Base fiscale ou devise différente');
 const expected=o.pricing.items,actual=expected.some(l=>l.type==='shipping_cost')?bc.line_items:bc.line_items?.filter(l=>!neutral(l));
 if(!Array.isArray(actual)||[...actual,...expected].some(l=>!Array.isArray(l.tax_codes)||l.tax_codes.some(t=>!t?.id)))throw Error('TVA source · Codes TVA non reçus');
 // Verify products and quantities independently before allowing different codes.
 verifyBcLineIdentity(actual?.map(l=>({...l,tax_codes:[]})),expected.map(l=>({...l,tax_codes:[]})));
 const matched=new Set(),updates=[];let changed=false;
 for(const l of actual){
  const candidates=expected.map((e,i)=>({e,i})).filter(({e,i})=>!matched.has(i)&&matchesSourceLine(l,e));
  if(candidates.length!==1)throw Error('TVA source · Lignes ou emplacements ambigus');
  const {e,i}=candidates[0];matched.add(i);
  if(codes(l)!==codes(e))changed=true;
  updates.push({id:String(l.id),price:e.price,tax_codes:e.tax_codes});
 }
 if(!changed)return null;
 if(actual.some(l=>!l.id||['discount','discount_rule_amount','ecotax'].some(k=>!Object.hasOwn(l,k)||l[k]!==null&&(l[k]===''||Number(l[k])!==0))))throw Error('TVA source · Remise ou écotaxe à rapprocher');
 if(Number(bc.invoices_count)!==0||Number(bc.paid_amount)!==0||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length)throw Error('TVA source · BC sans facture, paiement ni BL requis');
 // Erplain receives every existing line by id; omitted rows must not disappear.
 const byId=new Map(updates.map(l=>[l.id,l]));
 const input={line_items:bc.line_items.map(l=>{if(!l.id)throw Error('TVA source · Identifiant de ligne absent');return byId.get(String(l.id))||{id:String(l.id),price:l.price,tax_codes:l.tax_codes};})};
 return {input,target:hash({pricing:o.pricing,lines:input.line_items}),before:structuredClone(bc)};
}

export async function alignHistoricalSourceVat(api,o,{save,guard,preserveLabels}){
 if(usesRecordedBc(o))return {unchanged:true,authority:'recorded_erplain_bc',sourceAlignmentDisabled:true};
 if(o.channel!=='temu'||o.erp_live?.phase!=='historical_review'||!o.erp_live.bc?.id||o.erp_live.bl?.id||o.partial_mode||o.erp_live.equivalentItems||o.source_payload?.erplainImported)return {skipped:true};
 const read=async()=>(await api.request(`query V3SourceVatBC($id:ID!){Order(id:$id){${alignmentFields}}}`,{id:String(o.erp_live.bc.id)})).Order;
 const bc=await read(),plan=sourceVatPlan(bc,o),attempt=o.erp_live.sourceVatAttempt;
 if(!plan){
  if(attempt?.status==='uncertain'){
   if(attempt.sourceHash!==hash(o.pricing))throw Error('TVA source · Source modifiée après mutation incertaine');
   if(!Array.isArray(attempt.before?.line_items)||JSON.stringify(bc.line_items.map(l=>[String(l.id),identity(l)]).sort())!==JSON.stringify(attempt.before.line_items.map(l=>[String(l.id),identity(l)]).sort()))throw Error('TVA source · Identité des lignes modifiée après mutation incertaine');
   verifyBcPricing(bc,o.pricing);
   if(bc.update_stock!==attempt.stockPolicy)throw Error('TVA source · Politique de stock modifiée');
   const stock=bc.update_stock?await readHistoricalStock(api,bc):null;
   if(hash(stock)!==attempt.stockHash)throw Error('TVA source · Journal stock modifié');
   attempt.status='verified';attempt.verifiedAt=new Date().toISOString();await save(o);
  }
  return {unchanged:true};
 }
 if(attempt?.status==='uncertain')throw Error('TVA source · Mutation incertaine : rapprochement fournisseur requis, aucune réécriture');
 if(typeof guard!=='function'||typeof preserveLabels!=='function'||typeof save!=='function')throw Error('TVA source · Garde de conservation absente');
 let stock=null;if(bc.update_stock){await assertNoHistoricalStockRemoval(api,o);stock=await readHistoricalStock(api,bc);}
 await guard();await preserveLabels();await guard();
 o.erp_live.sourceVatAttempt={status:'uncertain',target:plan.target,sourceHash:hash(o.pricing),before:plan.before,stockPolicy:bc.update_stock,stockHash:hash(stock),requestedAt:new Date().toISOString(),authority:'current_source'};await save(o);
 let mutationError;try{await api.request('mutation V3AlignSourceVat($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id}}',{id:String(bc.id),input:plan.input});}catch(e){mutationError=e;}
 // One mutation attempt only. A lost response is confirmed by fresh read-back.
 const after=await read();
 if(String(after?.id)!==String(bc.id)||after.status!==bc.status||after.external_reference!==bc.external_reference||after.update_stock!==bc.update_stock||after.tax_type!==bc.tax_type||after.currency?.label!==bc.currency?.label||Number(after.invoices_count)!==0||Number(after.paid_amount)!==0||after.shipping_orders?.paginatorInfo?.hasMorePages!==false||after.shipping_orders.data.length||JSON.stringify(after.line_items.map(l=>[String(l.id),identity(l)]).sort())!==JSON.stringify(bc.line_items.map(l=>[String(l.id),identity(l)]).sort()))throw Error('TVA source · Résultat fournisseur non confirmé');
 try{verifyBcPricing(after,o.pricing);}catch(e){throw Error((mutationError?'TVA source · Réponse mutation incertaine : ':'')+e.message);}
 const afterStock=bc.update_stock?await readHistoricalStock(api,after):null;
 if(hash(stock)!==hash(afterStock))throw Error('TVA source · Journal stock modifié après correction');
 await guard();o.erp_live.sourceVatAttempt.status='verified';o.erp_live.sourceVatAttempt.verifiedAt=new Date().toISOString();await save(o);
 return {aligned:true,authority:'current_source',stockUnchanged:true};
}
