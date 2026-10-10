// Read-only proof for a cancelled BC that never managed stock and had no BL.
// Never infer absence of a stock cycle from missing local document IDs alone.
export async function proveCancelledCycleWithoutStock(api,order){
 const previous=order.erp_live?.previousCancelledCycle,oldId=String(previous?.bc?.id||''),currentId=String(order.erp_live?.bc?.id||'');
 const fail=reason=>{throw Error('Stock Erplain · Ancien cycle à rapprocher : '+reason);};
 if(!order.id||!/^\d+$/.test(oldId)||!/^\d+$/.test(currentId)||oldId===currentId||previous.stockDocument||previous.stockCreationAttemptedAt||previous.previousCancelledCycle||previous.bl?.id)fail('historique incomplet ou plusieurs cycles');
 const {Order:bc}=await api.request('query V3CancelledPreviousBC($id:ID!){Order(id:$id){id label created_at status update_stock line_items{type quantity variant{id} location{id}} shipping_orders(first:100){data{id status} paginatorInfo{hasMorePages}}}}',{id:oldId});
 if(String(bc?.id)!==oldId||bc.status!=='cancelled'||bc.update_stock!==false||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length)fail('ancien BC non annulé, gestion de stock ou BL existant');
 if(!Array.isArray(bc.line_items)||!bc.line_items.some(l=>l.type==='normal'))fail('lignes ancien BC absentes');
 const variants=new Set();
 for(const l of bc.line_items){
  if(l.type==='shipping_cost')continue;
  if(l.type!=='normal'||!/^\d+$/.test(String(l.variant?.id||''))||!l.location?.id||l.quantity==null||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)fail('lignes ancien BC incomplètes');
  variants.add(String(l.variant.id));
 }
 const date=String(bc.created_at||'');
 if(!/^\d{4}-\d{2}-\d{2}[ T]/.test(date)||!Number.isFinite(Date.parse(date.replace(' ','T'))))fail('date ancien BC absente');
 const labels=['V3FS-'+order.id,'V3FS-'+order.id+'-BC'+oldId];
 const {StockRemovals:stock}=await api.request('query V3CancelledPreviousStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:100,where:$where){data{id label status} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'IN',value:labels}});
 // Even a cancelled stock document needs the existing stock-document recovery
 // path; this branch must only prove that no such document ever needs recovery.
 if(!Array.isArray(stock?.data)||stock.paginatorInfo?.hasMorePages!==false||stock.data.length)fail('sortie de stock trouvée ou recherche incomplète');
 const evidence=[];
 for(const variant of variants){
  const seen=new Set(),net=new Map();let complete=false;
  for(let page=1;page<=100;page++){
   const {InventoryLogs:logs}=await api.request('query V3CancelledPreviousLedger($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type on_hand_diff available_diff variant{id} location{id}} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:date.slice(0,10)+' 00:00:00'}]}});
   if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean')fail('journal ancien BC incomplet');
   for(const l of logs.data){
    if(!l?.id||String(l.variant?.id)!==variant||seen.has(String(l.id)))fail('journal incohérent ou pagination répétée');seen.add(String(l.id));
    if(String(l.document_id)!==oldId)continue;
    if(!l.order_type)fail('type du mouvement non reçu');
    if(l.order_type!=='Order')continue;
    if(!l.location?.id||[l.on_hand_diff,l.available_diff].some(v=>v==null||String(v).trim()===''||!Number.isFinite(Number(v))))fail('mouvement ancien BC incomplet');
    const key=String(l.location.id),sum=net.get(key)||{onHand:0,available:0};sum.onHand+=Number(l.on_hand_diff);sum.available+=Number(l.available_diff);net.set(key,sum);
   }
   if(!logs.paginatorInfo.hasMorePages){complete=true;break;}
  }
  if(!complete)fail('journal trop volumineux');
  if([...net.values()].some(s=>Math.abs(s.onHand)>1e-7||Math.abs(s.available)>1e-7))fail('déduction de stock non compensée');
  evidence.push({variant,complete,locations:[...net].map(([location,sum])=>({location,...sum}))});
 }
 return {oldBcId:oldId,currentBcId:currentId,oldBcCancelled:true,oldBcManagedStock:false,noShippingOrders:true,noStockRemovals:true,labels,evidence};
}
