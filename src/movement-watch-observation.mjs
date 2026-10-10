import {readHistoricalStock} from './historical-stock-proof.mjs';
import {reconcileFullStock} from './stock-cycle.mjs';
import {createHash} from 'node:crypto';
const fields='id label status created_at update_stock line_items{id type quantity variant{id sku track_inventory} location{id}} shipping_orders(first:100){data{id label status update_stock line_items{parent_id type quantity variant{id} location{id}}} paginatorInfo{hasMorePages}}';
export function observationFingerprint(o){const s=o.erp_live||{},p=o.source_payload||{};return createHash('sha256').update(JSON.stringify({id:o.id,reference:o.reference,erp:{phase:s.phase,bc:s.bc,bl:s.bl,stockDocument:s.stockDocument,previousCancelledCycle:s.previousCancelledCycle,equivalentItems:s.equivalentItems,stockCreationAttemptedAt:s.stockCreationAttemptedAt,stockCreationOutcome:s.stockCreationOutcome,stockPendingVariants:s.stockPendingVariants},hold:p.selectedReimport,cancelled:p.cancelled,cancelledAt:p.cancelledAt,temuStatus:p.temuOrderDetail?.parentOrderMap?.parentOrderStatus,correction:p.marketplacePendingCorrection,suspension:o.suspension,archived:o.archived,partial:o.partial_mode,tracking:o.tracking_status,label:o.label_status,held:o.resolution_pending_resume,issue:o.issue})).digest('hex');}
export function observationApi(api,{timeoutMs=600000}={}){const ledgers=new Map(),deadline=Date.now()+timeoutMs;let expired=false;return Object.freeze({async request(query,variables){const q=String(query).replace(/#[^\n]*/g,'').trim();if(!/^query\s+[A-Za-z][A-Za-z0-9_]*\s*(?:\(|\{)/.test(q)||/\b(mutation|subscription)\b/.test(q))throw Error('Lecture Erplain requise');const remaining=deadline-Date.now();if(expired||remaining<=0)throw Error('Délai de lecture dépassé : nouvelle vérification programmée');let timer,result;try{result=await Promise.race([api.request(query,variables),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Délai de lecture dépassé : nouvelle vérification programmée'));},remaining);})]);}finally{clearTimeout(timer);}
 if(result?.InventoryLogs){const key=JSON.stringify([q,variables?.where]);if(variables?.page===1)ledgers.set(key,new Set());const seen=ledgers.get(key)||new Set();for(const row of result.InventoryLogs.data||[]){if(!row.id||seen.has(String(row.id)))throw Error('Journal incohérent : pagination répétée');seen.add(String(row.id));}ledgers.set(key,seen);}return result;
}});}
export async function observeMovement(api,order){
 api=observationApi(api);const state=order.erp_live||{};
 const result={checkedAt:new Date().toISOString(),sourceFingerprint:observationFingerprint(order),writeAllowed:false,resumeAllowed:false,proof:null,documents:[],reasonCode:null,detail:null};
 const references=[String(order.reference||''),'V3:'+order.id];
 const candidates=(await api.request('query MovementWatchCandidates($where:QueryOrdersWhereWhereConditions){Orders(first:100,where:$where){data{id label status external_reference} paginatorInfo{hasMorePages}}}',{where:{column:'EXTERNAL_REFERENCE',operator:'IN',value:references}})).Orders;
 if(!Array.isArray(candidates?.data)||candidates.paginatorInfo?.hasMorePages!==false)throw Error('Recherche BC incomplète');
 const known=[state.bc,...(order.source_payload?.selectedReimport?.previousBC||[]),state.previousCancelledCycle?.bc].filter(b=>b?.id);
 const ids=[...new Set([...known.map(b=>String(b.id)),...candidates.data.map(b=>String(b.id))])];
 if(ids.length>10)throw Error('Historique BC trop volumineux : contrôle requis');
 if(!ids.length)return {...result,reasonCode:'bc_not_identified',detail:'Aucun BC identifié : absence de sortie non démontrée. Rapprochement historique nécessaire.'};
 const labels=[...new Set(['V3FS-'+order.id,...ids.map(id=>'V3FS-'+order.id+'-BC'+id)])];
 const stocks=(await api.request('query MovementWatchStockDocuments($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status update_stock notes line_items{quantity variant{id} location{id}}} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'IN',value:labels}})).StockRemovals;
 if(!Array.isArray(stocks?.data)||stocks.paginatorInfo?.hasMorePages!==false)throw Error('Recherche mouvements incomplète');
 for(const id of ids){if(!/^\d+$/.test(id))throw Error('Identité BC invalide');const bc=(await api.request(`query MovementWatchReadBC($id:ID!){Order(id:$id){${fields}}}`,{id})).Order;if(String(bc?.id)!==id)throw Error('BC demandé non reçu');result.documents.push(bc);}
 const active=result.documents.filter(b=>b.status==='active');
 if(active.length>1)return {...result,reasonCode:'multiple_active_bc',detail:'Plusieurs BC actifs : rapprochement individuel requis.'};
 const current=state.bc?.id?result.documents.find(b=>String(b.id)===String(state.bc.id)):active[0];
 if(!current||current.status==='cancelled')return {...result,reasonCode:'cancelled_bc',detail:'BC historique annulé : conserver l’arrêt métier et vérifier les compensations de stock.'};
 if(current.update_stock===true){
  if(stocks.data.length||state.stockCreationAttemptedAt)return {...result,reasonCode:'additional_stock_history',detail:'BC gérant le stock et sortie séparée ou tentative connue : risque de double déduction à rapprocher.'};
  if(state.bl?.id)return {...result,reasonCode:'historical_bl_to_reconcile',detail:'BL historique identifié : contrôler son journal et sa relation au BC avant continuation.'};
  const extra=[...(state.historicalStockProof?.quantities||[]).map(l=>l.key.split(':')[0]),...(state.stockPendingVariants||[])];
  const proof=(await readHistoricalStock(api,current,{additionalVariants:extra})).proof;
  return {...result,reasonCode:'historical_deduction_verified',detail:'Déduction de stock de l’ancien BC confirmée. Aucune nouvelle sortie ; reprise historique et autres motifs à vérifier.',proof};
 }
 if(stocks.data.length&&state.bc?.id&&state.bl?.id&&state.phase==='creating_stock'){
  const bl=(await api.request('query MovementWatchCycleBL($id:ID!){ShippingOrder(id:$id){id status update_stock line_items{type quantity variant{id} location{id}}}}',{id:String(state.bl.id)})).ShippingOrder;
  if(String(bl?.id)!==String(state.bl.id))throw Error('BL demandé non reçu');
  const items=state.equivalentItems||current.line_items.filter(l=>l.type==='normal');
  const stock=await reconcileFullStock(api,{...order,items},{allowCreate:false,allowRecoverMissing:false});
  if(stock)return {...result,reasonCode:'cycle_movement_verified',detail:'Mouvement du cycle actuel vérifié : reprise possible uniquement si les gardes métier existantes l’autorisent.',proof:{stock,bcId:String(state.bc.id),blId:String(state.bl.id)}};
 }
 if(stocks.data.length)return {...result,reasonCode:'stock_document_found',detail:'Mouvement de stock retrouvé : contrôler les quantités, le BL et les anciens cycles avant toute reprise.',stockDocuments:stocks.data};
 return {...result,reasonCode:'absence_not_proven',detail:'Aucun mouvement retrouvé par ces références ; cela ne prouve pas l’absence de sortie. Vérification historique maintenue.'};
}
