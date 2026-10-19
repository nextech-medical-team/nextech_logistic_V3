import {isDeepStrictEqual} from 'node:util';
import {recoverOrder,technicalMarker,externalReference} from './erplain-document-metadata.mjs';
import {erplainCustomerInput} from './erplain-customer-input.mjs';
import {suspensionBlock} from './order-suspension.mjs';

function scope(o,bcId){
 const s=o?.erp_live||{},p=o?.source_payload||{};
 if(!o||!['temu','amazon'].includes(o.channel)||o.archived||o.partial_mode||o.simulation||suspensionBlock(o)||p.erplainImported||p.marketplacePendingCorrection||p.visibilityHold||p.erplainValidationHold||['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)||o.label_status==='cancelled')throw Error('BC absent : commande protégée, rapprochement manuel requis');
 if(!bcId||String(s.bc?.id)!==bcId||s.phase!=='bc_created'||s.bc.status&&s.bc.status!=='unpublished'||!s.customer?.id)throw Error('BC absent : seul un brouillon enregistré avant création du BL peut être repris');
 if(s.bl||s.stockDocument||s.stockCreationAttemptedAt||s.stockCreationOutcome||s.stockPendingVariants?.length||s.previousCancelledCycle||s.historicalStockProof||s.stockCheckedAt||s.verifiedAt||s.documentSource?.shippingOrders?.length||s.equivalentOriginalLines?.length||s.mappingAlignmentAttempt||s.sourceVatAttempt)throw Error('BC absent : historique de livraison, stock ou modification à rapprocher');
 if(!Number.isFinite(Date.parse(o.received_at)))throw Error('BC absent : date de réception V3 non vérifiable');
}
async function idle(db,id,resolutionId){
 const rows=(await db.query(`SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing')
 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') AND (id<>$2 OR action IS DISTINCT FROM 'refresh' OR status<>'running')
 UNION ALL SELECT 1 FROM correction_jobs WHERE order_id=$1 AND status IN ('queued','applying','checking','waiting')
 UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1
 UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')`,[id,resolutionId])).rows;
 if(rows.length)throw Error('BC absent : autre traitement en cours, reprise différée');
}
async function pages(api,query,key,variables,inspect,stage){
 const seen=new Set();
 for(let page=1;page<=200;page++){
  await stage('Contrôle Erplain '+key+' · page '+page);
  const result=await api.request(query,{...variables,page});
  if(result?._v3Errors?.length)throw Error('BC absent : erreur API pendant la vérification');
  const list=result?.[key];
  if(!Array.isArray(list?.data)||typeof list.paginatorInfo?.hasMorePages!=='boolean'||list.paginatorInfo.hasMorePages&&!list.data.length)throw Error('BC absent : recherche '+key+' incomplète');
  for(const row of list.data){if(!row?.id||seen.has(String(row.id)))throw Error('BC absent : pagination '+key+' incohérente');seen.add(String(row.id));inspect(row);}
  if(!list.paginatorInfo.hasMorePages)return seen.size;
 }
 throw Error('BC absent : historique trop volumineux pour une reprise automatique');
}
// Authorize only a missing draft before any shipping/stock attempt. The normal
// preparation worker creates the replacement after revalidating source and stock.
export async function recoverMissingBc(db,api,o,{bcId,reference,confirmed,resolutionId,stage=async()=>{}}={}){
 if(confirmed!==true||reference!==o.reference||!resolutionId)throw Error('Confirmation de la commande et du BC absent requise');
 scope(o,bcId);await idle(db,o.id,resolutionId);await api.verify();
 const originalApi=api;api={request:async(...args)=>{const result=await originalApi.request(...args);if(result?._v3Errors?.length)throw Error('BC absent : réponse API partielle, aucune reprise');return result;}};
 const read=()=>api.request('query V3MissingBcIdentity($id:ID!){Order(id:$id){id label status external_reference}}',{id:bcId});
 const absent=r=>{if(r?._v3Errors?.length||r?.Order!==null)throw Error('BC encore présent ou réponse incomplète : aucune recréation autorisée');};
 absent(await read());
 const found=await recoverOrder(api,o,{db});
 if(found)throw Error('Un BC existant correspond à cette commande : '+found.label+'. Rattachement à vérifier, aucune recréation');
 const customer=await api.request('query V3MissingBcCustomer($id:ID!){Customer(id:$id){id customer_number}}',{id:String(o.erp_live.customer.id)});
 if(customer?._v3Errors?.length||String(customer?.Customer?.id)!==String(o.erp_live.customer.id)||customer.Customer.customer_number!==erplainCustomerInput(o).customer_number)throw Error('BC absent : identité du client à rapprocher avant reprise');
 const marker=technicalMarker(o),ref=externalReference(o);
 const shippingCount=await pages(api,'query V3MissingBcShipping($page:Int!){ShippingOrders(first:100,page:$page){data{id external_reference notes orders(first:100){data{id} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}','ShippingOrders',{},bl=>{
  if(!Array.isArray(bl.orders?.data)||bl.orders.paginatorInfo?.hasMorePages!==false||bl.orders.data.some(b=>!b.id))throw Error('BC absent : rattachement BL incomplet');
  if(bl.orders.data.some(b=>String(b.id)===bcId)||[ref,'V3:'+o.id].includes(bl.external_reference)||String(bl.notes||'').includes(marker))throw Error('BC absent : un BL associé existe, aucun nouveau cycle autorisé');
 },stage);
 for(const label of ['V3FS-'+o.id,'V3FS-'+o.id+'-BC'+bcId])await pages(api,'query V3MissingBcStock($where:QueryStockRemovalsWhereWhereConditions!,$page:Int!){StockRemovals(first:100,page:$page,where:$where){data{id} paginatorInfo{hasMorePages}}}','StockRemovals',{where:{column:'LABEL',operator:'EQ',value:label}},()=>{throw Error('BC absent : sortie de stock existante, rapprochement requis');},stage);
 // These non-imported drafts were created by V3 after the order was received.
 const since=new Date(Math.min(Date.parse(o.received_at),Date.parse(o.erp_live.bc.created_at)||Infinity)-86400000).toISOString().slice(0,10)+' 00:00:00';
 const ledgerCount=await pages(api,'query V3MissingBcLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type} paginatorInfo{hasMorePages}}}','InventoryLogs',{where:{column:'CREATED_AT',operator:'GTE',value:since}},row=>{
  if(row.document_id==null||!row.order_type)throw Error('BC absent : journal stock incomplet');
  if(String(row.document_id)===bcId&&row.order_type==='Order')throw Error('BC absent : mouvement ou réservation du BC retrouvé, rapprochement requis');
 },stage);
 // Repeat identity reads after the potentially long paginated history scan.
 absent(await read());if(await recoverOrder(api,o,{db}))throw Error('BC réapparu pendant la vérification : actualiser la commande');
 return db.transaction(async tx=>{
  const current=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];scope(current,bcId);
  if(!isDeepStrictEqual(current,o))throw Error('Commande modifiée pendant les contrôles : reprise différée');
  await idle(tx,o.id,resolutionId);
  const before=current.erp_live;
  const recovery={resolutionId,checkedAt:new Date().toISOString(),oldBcId:bcId,reference,shippingCount,ledgerCount,since,confirmedByOperator:true,previousState:before,previousIssue:current.issue};
  const state={phase:'customer_created',customer:before.customer,...(before.customerNumber?{customerNumber:before.customerNumber}:{}),...(before.customerCreationAttempt?{customerCreationAttempt:before.customerCreationAttempt}:{}),missingBcRecovery:recovery};
  await tx.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[o.id,JSON.stringify(state)]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','erplain.missing_bc_retry_authorized',$1)",[JSON.stringify({orderId:o.id,...recovery,externalWrites:0,labelsPreserved:true})]);
  return {erpOnly:true,existingLabelsPreserved:true,message:'Ancien BC absent et contrôles terminés. Reprise de la préparation avec conservation de l’étiquette existante.',missingBcRecovery:{oldBcId:bcId,resolutionId}};
 });
}
