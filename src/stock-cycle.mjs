import {prepareFifoStockLines,assertStockLotAssignments} from './stock-lots.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';
import {proveCancelledCycleWithoutStock} from './cancelled-cycle-proof.mjs';
const fields='id label status update_stock notes line_items{quantity variant{id} location{id} batch_numbers{quantity batch_number{id}}}';
function totals(lines){const m=new Map();for(const l of lines||[]){if(l.type&&l.type!=='normal')continue;const q=Number(l.quantity);if(!l.variant?.id||!l.location?.id||!Number.isFinite(q)||q<=0)throw Error('Stock Erplain : lignes incomplètes, rapprochement nécessaire');const k=l.variant.id+':'+l.location.id;m.set(k,(m.get(k)||0)+q)}if(!m.size)throw Error('Stock Erplain : document sans produit');return JSON.stringify([...m].sort());}
export function stockCycleLabel(o){return 'V3FS-'+o.id+(o.erp_live.previousCancelledCycle?'-BC'+o.erp_live.bc.id:'');}
export async function proveAbsentStockEffect(api,o,{now=Date.now()}={}){
 const s=o.erp_live,attempt=Date.parse(s.stockCreationAttemptedAt);
 if(!Number.isFinite(attempt)||now-attempt<600000||s.stockCreationOutcome?.kind==='confirmed_response')return null;
 const variants=[...new Set(o.items.map(l=>String(l.variant?.id)))].sort(),original=[...new Set((s.stockPendingVariants||[]).map(String))].sort();
 if(!variants.length||variants.length>20||JSON.stringify(variants)!==JSON.stringify(original))return null;
 // Search every location, with a two-day margin for historical timestamps.
 // Any debit (even unrelated) makes absence unprovable; never infer it from
 // a partial result, a current stock balance or an empty label lookup alone.
 const since=new Date(attempt-172800000).toISOString().slice(0,10)+' 00:00:00';
 let records=0;
 for(const id of variants){let complete=false;
  for(let page=1;page<=10;page++){
   const r=await api.request('query ProveAbsentStockEffect($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id created_at on_hand_diff variant{id}} paginatorInfo{hasMorePages}}}',{where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:id},{column:'CREATED_AT',operator:'GTE',value:since}]},page}),d=r.InventoryLogs;
   if(!Array.isArray(d?.data)||typeof d.paginatorInfo?.hasMorePages!=='boolean')return null;
   for(const l of d.data){if(String(l.variant?.id)!==id||l.on_hand_diff==null||!Number.isFinite(Number(l.on_hand_diff))||!Number.isFinite(Date.parse(l.created_at))||Number(l.on_hand_diff)<0)return null;records++;}
   if(!d.paginatorInfo.hasMorePages){complete=true;break;}if(!d.data.length)return null;
  }if(!complete)return null;
 }
 return {complete:true,attemptedAt:s.stockCreationAttemptedAt,bcId:String(s.bc.id),blId:String(s.bl.id),label:stockCycleLabel(o),variantIds:variants,since,records,checkedAt:new Date(now).toISOString(),basis:'complete_inventory_ledger_no_debit_all_locations'};
}
export async function reconcileFullStock(api,o,{allowCreate=false,allowRecoverMissing=false,beforeCreate=async()=>{},onCreated=async()=>{},onCreationFailure=async()=>{},onAbsenceConfirmed=async()=>{}}={}){
 const state=o.erp_live,label=stockCycleLabel(o),previous=state.previousCancelledCycle;
 if(previous && !previous.stockDocument?.id && Object.keys(previous).length===1 && previous.bcReconciliation?.status==='missing' && Number.isFinite(Date.parse(previous.bcReconciliation.checkedAt))){
  // A reimport may preserve only a failed BC lookup, not an actual stock cycle.
  // Verify the legacy reference is absent before treating it as an empty history.
  const legacy=await api.request(`query VerifyEmptyPreviousStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:2,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'LABEL',operator:'EQ',value:'V3FS-'+o.id}});
  if(!Array.isArray(legacy.StockRemovals?.data)||legacy.StockRemovals.paginatorInfo?.hasMorePages!==false||legacy.StockRemovals.data.length)throw Error('Stock Erplain : ancien mouvement trouvé ou recherche incomplète, rapprochement nécessaire');
 }else if(previous&&!previous.stockDocument?.id){await proveCancelledCycleWithoutStock(api,o);}
 else if(previous){if(String(previous.bc?.id)===String(state.bc?.id))throw Error('Stock Erplain : ancien cycle non identifié, rapprochement nécessaire');const old=(await api.request(`query PreviousStock($id:ID!){StockRemoval(id:$id){${fields}}}`,{id:String(previous.stockDocument.id)})).StockRemoval;if(!old||old.label!==previous.stockDocument.label||old.status!=='cancelled')throw Error('Stock Erplain : ancien mouvement non annulé, aucune nouvelle déduction');}
 const r=await api.request(`query FindCycleStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:2,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'LABEL',operator:'EQ',value:label}});
 if(!Array.isArray(r.StockRemovals?.data)||r.StockRemovals.paginatorInfo?.hasMorePages!==false||r.StockRemovals.data.length>1)throw Error('Stock Erplain : recherche incomplète ou ambiguë');
 let found=r.StockRemovals.data[0];
 const receipt=state.stockCreationOutcome;
 if(!found&&receipt?.kind==='confirmed_response'&&receipt.documentId&&receipt.attemptedAt===state.stockCreationAttemptedAt&&receipt.bcId===String(state.bc.id)&&receipt.blId===String(state.bl.id))found=(await api.request(`query ReadStockCreationReceipt($id:ID!){StockRemoval(id:$id){${fields}}}`,{id:receipt.documentId})).StockRemoval;
 const documents=await api.request('query CheckCycleStock($bc:ID!,$bl:ID!){Order(id:$bc){id status update_stock line_items{type quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}} ShippingOrder(id:$bl){id label status update_stock line_items{type quantity variant{id} location{id}}}}',{bc:String(state.bc.id),bl:String(state.bl.id)});
 const bc=documents.Order,bl=documents.ShippingOrder;
 if(String(bc?.id)!==String(state.bc.id)||String(bl?.id)!==String(state.bl.id)||bc?.status!=='active'||bc.update_stock!==false||!['pending','in_preparation','ready_to_ship'].includes(bl?.status)||bl.update_stock!==false||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||!bc.shipping_orders.data.some(x=>String(x.id)===String(bl.id)))throw Error('Stock Erplain : BC/BL non conformes, rapprochement nécessaire');
 const expected=totals(o.items);if(totals(bc.line_items)!==expected||totals(bl.line_items)!==expected)throw Error('Stock Erplain : produits, lieux ou quantités différents');
 const check=d=>{if(!d?.id||d.label!==label||d.status!=='completed'||d.update_stock!==true||d.notes!=='LIVE : sortie de stock liée au BL '+bl.label||totals(d.line_items)!==expected)throw Error('Stock Erplain : mouvement existant incompatible, aucune nouvelle déduction');return {id:d.id,label:d.label,status:d.status,update_stock:d.update_stock}};
 if(found)return check(found);
 if(!allowCreate&&allowRecoverMissing&&bc.line_items.filter(l=>!l.type||l.type==='normal').every(l=>l.variant?.track_inventory===true)){
  const proof=await proveAbsentStockEffect(api,o);
  if(proof){
   const latest=(await api.request(`query RecheckAbsentCycleStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:2,where:$where){data{${fields}} paginatorInfo{hasMorePages}}}`,{where:{column:'LABEL',operator:'EQ',value:label}})).StockRemovals;
   if(!Array.isArray(latest?.data)||latest.paginatorInfo?.hasMorePages!==false||latest.data.length>1)throw Error('Stock Erplain : recherche finale incomplète ou ambiguë');
   if(latest.data.length)return check(latest.data[0]);
   await onAbsenceConfirmed(proof);allowCreate=true;
  }
 }
 if(!allowCreate)return null;
 if(bl.status!=='pending')throw Error('Stock Erplain : BL déjà prêt sans mouvement identifié, aucune nouvelle déduction');
 assertFullOrderStock(bc.line_items);
 const source=String(o.source_date||''),fr=source.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);const datedAt=fr?`${fr[3]}-${fr[2]}-${fr[1]}`:/^\d{4}-\d{2}-\d{2}/.test(source)?source.slice(0,10):new Date().toISOString().slice(0,10);
 const stockLines=await prepareFifoStockLines(api,o.items);
 await beforeCreate();
 let made;
 try{made=await api.request('mutation CreateCycleStock($input:StockAdjustmentInput!){CreateStockRemoval(input:$input){id}}',{input:{label,status:'completed',update_stock:true,dated_at:datedAt,notes:'LIVE : sortie de stock liée au BL '+bl.label,line_items:stockLines}});}catch(e){await onCreationFailure(e);throw e;}
 if(!made.CreateStockRemoval?.id)throw Error('Stock Erplain : création non confirmée, rapprocher avant reprise');
 await onCreated(made.CreateStockRemoval.id);
 const verified=(await api.request(`query VerifyCycleStock($id:ID!){StockRemoval(id:$id){${fields}}}`,{id:String(made.CreateStockRemoval.id)})).StockRemoval;assertStockLotAssignments(verified?.line_items,stockLines);return check(verified);
}
