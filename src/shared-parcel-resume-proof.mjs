import{readFile}from'node:fs/promises';import path from'node:path';
import{readErplainDocuments}from'./erplain-document-read.mjs';
import{assertNoHistoricalStockRemoval}from'./historical-stock-proof.mjs';
import{temuApi}from'./temu-api.mjs';
export function sharedParcelResumeProofReader(api,directory,{readDocuments=readErplainDocuments,assertNoExtraStock=assertNoHistoricalStockRemoval,createTemu=temuApi,loadConfig=async()=>JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,''))}={}){
 return async(before,packageSn)=>{
  let reads=0;const count=()=>{if(++reads>32)throw Error('Shared parcel supplier read limit exceeded');};
  const provider={request:(q,...a)=>{if(!/^\s*query\b/.test(q)||/\bmutation\b/i.test(q))throw Error('Shared parcel provider mutation prohibited');count();return api.request(q,...a);}};
  const identity=(await provider.request('query V3SharedResumeAccount { Company { id } }')).Company;
  if(Number(identity?.id)!==100174)throw Error('Erplain account identity mismatch');
  const orders=[];
  for(const {order:o} of before.members){
   const bc=await readDocuments(provider,o.erp_live?.bc?.id);
   await assertNoExtraStock(provider,o);
   const since=String(bc.dated_at||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(since))throw Error('Historical stock date unavailable');
   const variants=[...new Set((bc.line_items||[]).filter(x=>x.type==='normal').map(x=>String(x.variant?.id||'')))];
   if(!variants.length||variants.length>10||variants.some(x=>!/^\d+$/.test(x)))throw Error('Historical event scope unavailable');
   const rows=[];let complete=true;
   for(const variant of variants){let done=false;for(let page=1;page<=5;page++){
    const logs=(await provider.request('query V3SharedResumeSavedEvents($where:QueryInventoryLogsWhereWhereConditions!,$page:Int!){InventoryLogs(first:100,page:$page,where:$where){data{id document_id order_type variant{id} created_at} paginatorInfo{hasMorePages}}}',{page,where:{AND:[{column:'VARIANT_ID',operator:'EQ',value:variant},{column:'CREATED_AT',operator:'GTE',value:since+' 00:00:00'}]}})).InventoryLogs;
    if(!Array.isArray(logs?.data)||typeof logs.paginatorInfo?.hasMorePages!=='boolean')throw Error('Historical event ledger incomplete');
    rows.push(...logs.data.filter(x=>String(x.document_id)===String(bc.id)&&x.order_type==='Order'));
    if(!logs.paginatorInfo.hasMorePages){done=true;break;}
   }if(!done)complete=false;}
   const saved=(o.erp_live.historicalStockProof?.logIds||[]).map(String);
   orders.push({reference:o.reference,bc:{id:bc.id,status:bc.status,externalReference:bc.external_reference,updateStock:bc.update_stock},shippingConnectionComplete:bc.shipping_orders?.paginatorInfo?.hasMorePages===false,bls:(bc.shipping_orders?.data||[]).map(b=>({id:b.id,status:b.status,externalReference:b.external_reference,updateStock:b.update_stock})),noAdditionalStockRemoval:true,ledgerComplete:complete,savedHistoricalEvents:saved,savedEventsStillPresent:saved.length>0&&saved.every(id=>rows.some(x=>String(x.id)===id))});
  }
  const malls=[...new Set(before.members.map(m=>String(m.order.source_payload?.mallId||'')))];
  if(malls.length!==1||!/^\d+$/.test(malls[0]))throw Error('Shared package shop identity unavailable');
  const config=await loadConfig();let temu=createTemu(config);
  const read=(client,type,data)=>{if(!['bg.open.accesstoken.info.get','bg.logistics.shipment.result.get'].includes(type))throw Error('Only package registry reads allowed');count();return client.read(type,data);};
  const token=await read(temu,'bg.open.accesstoken.info.get',{});
  if(String(token.mallId)!==malls[0]){const selected=(token.associatedMallTokenList||[]).find(x=>String(x.mallId)===malls[0]);if(!selected?.accessToken)throw Error('Verified shop token unavailable');temu=createTemu({...config,TEMU_ACCESS_TOKEN:selected.accessToken});if(String((await read(temu,'bg.open.accesstoken.info.get',{})).mallId)!==malls[0])throw Error('Shop token identity mismatch');}
  const result=await read(temu,'bg.logistics.shipment.result.get',{packageSnList:[packageSn]});
  if(!Array.isArray(result.packageInfoResultList)||result.packageInfoResultList.length!==1||result.packageInfoResultList[0].packageSn!==packageSn)throw Error('Current package registry incomplete');
  const p=result.packageInfoResultList[0];
  return {orders,registry:{package:p.packageSn,labelStatus:p.shippingLabelStatus,tracking:p.trackingNumber,failure:p.failReasonText||null,orderReferences:[...new Set((p.orderSendInfoList||[]).map(x=>x.parentOrderSn))]},providerReads:reads,providerWrites:0};
 };
}
