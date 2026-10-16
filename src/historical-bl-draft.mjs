import {usesNativeBlCycle,readNativeBlCycle} from './native-bl-policy.mjs';
import {assertNoHistoricalStockRemoval} from './historical-stock-proof.mjs';

const fail=reason=>{throw Error('BL historique brouillon : '+reason);};
function quantities(rows,requireType=false){
 if(!Array.isArray(rows))return fail('lignes absentes');
 const totals=new Map();
 for(const l of rows){
  if(l.type==='shipping_cost')continue;
  if((requireType?l.type!=='normal':l.type&&l.type!=='normal')||!l.variant?.id||!l.location?.id||l.quantity==null||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)return fail('lignes invalides');
  const key=String(l.variant.id)+':'+String(l.location.id);totals.set(key,(totals.get(key)||0)+Number(l.quantity));
 }
 if(!totals.size)return fail('aucun produit');
 return JSON.stringify([...totals].sort());
}
async function noBlMovement(api,bl){
 const created=String(bl.created_at||'');
 if(!/^\d{4}-\d{2}-\d{2}[ T]/.test(created)||!Number.isFinite(Date.parse(created.replace(' ','T'))))return fail('date non vérifiée');
 for(const variant of new Set(bl.line_items.filter(l=>l.type==='normal').map(l=>String(l.variant.id)))){
  if(!/^\d+$/.test(variant))return fail('variante invalide');
  let complete=false;
  for(let page=1;page<=100;page++){
   const {InventoryLogs:logs}=await api.request('query V3HistoricalDraftLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type variant{id}} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:created.slice(0,10)+' 00:00:00'}]}});
   if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean')return fail('journal incomplet');
   if(logs.data.some(l=>!l.id||l.document_id==null||String(l.variant?.id)!==variant))return fail('mouvement incomplet');
   if(logs.data.some(l=>String(l.document_id)===String(bl.id)))return fail('mouvement de stock déjà présent, rapprochement requis');
   if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
  }
  if(!complete)return fail('journal trop volumineux');
 }
}

// Called under the worker shipment lock. Erplain stock flags are immutable.
// Validate the inherited policy without attempting to rewrite the document.
// Publication retains its full BC and BL ledger proof.
export async function normalizeHistoricalDraft(api,o){
 if(usesNativeBlCycle(o))return (await readNativeBlCycle(api,o)).bl;
 const bcId=String(o.erp_live?.bc?.id||''),blId=String(o.erp_live?.bl?.id||'');
 if(!/^\d+$/.test(bcId)||!/^\d+$/.test(blId))return fail('documents non identifiés');
 const read=async()=>{
  const r=await api.request('query V3HistoricalDraftDocuments($bc:ID!,$bl:ID!){Order(id:$bc){id status update_stock line_items{type quantity location{id} variant{id}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}} ShippingOrder(id:$bl){id label created_at status update_stock line_items{id type quantity price tax_amount ecotax discount discount_type description variant{id} location{id}} orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{bc:bcId,bl:blId});
  const bc=r.Order,bl=r.ShippingOrder;
  if(String(bc?.id)!==bcId||bc.status!=='active'||bc.update_stock!==true)return fail('BC différent ou non actif');
  if(String(bl?.id)!==blId||bl.status!=='unpublished'||typeof bl.update_stock!=='boolean')return fail('BL publié ou politique inconnue');
  if(bc.shipping_orders?.paginatorInfo?.hasMorePages!==false||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.data.length>1||(bc.shipping_orders.data.length===1&&String(bc.shipping_orders.data[0].id)!==blId)||bl.orders?.paginatorInfo?.hasMorePages!==false||bl.orders?.data?.length!==1||String(bl.orders.data[0].id)!==bcId)return fail('relations BC/BL non exclusives');
  if(quantities(o.items)!==quantities(bc.line_items,true)||quantities(o.items)!==quantities(bl.line_items,true))return fail('produits, quantités ou emplacements différents');
  return {bc,bl};
 };
 const before=await read();
 await assertNoHistoricalStockRemoval(api,o);
 await noBlMovement(api,before.bl);
 const current=await read();
 if(JSON.stringify(current)!==JSON.stringify(before))return fail('documents modifiés pendant le contrôle');
 return current.bl;
}
