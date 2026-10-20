import {readHistoricalStock} from './historical-stock-proof.mjs';

// Read only: a lost local receipt never authorizes another stock deduction.
export async function reconcilePartialStock(api,bc,delivery,{hasSeparateStock=false}={}){
 const bl=delivery.bl;
 if(delivery.stock_document||!bl?.id||['cancelled','unpublished'].includes(bl.status))return null;
 const label='V3PS-'+delivery.id;
 const response=await api.request('query V3RecoverPartialStock($where:QueryStockRemovalsWhereWhereConditions!){StockRemovals(first:2,where:$where){data{id label status update_stock line_items{quantity variant{id} location{id}}} paginatorInfo{hasMorePages}}}',{where:{column:'LABEL',operator:'EQ',value:label}});
 const found=response.StockRemovals;
 if(response._v3Errors?.length||!Array.isArray(found?.data)||found.paginatorInfo?.hasMorePages!==false||found.data.length>1)throw Error('Recherche de sortie de stock incomplète ou ambiguë : rapprochement requis');
 if(found.data.length){
  const stock=found.data[0];
  if(!stock.id||stock.label!==label||bc.update_stock!==false||bl.update_stock!==false)throw Error('Politique ou identité de sortie de stock incompatible : rapprochement requis');
  return {document:stock,stock};
 }
 if(bc.update_stock!==true||hasSeparateStock)return null;
 const strictApi={request:async(...args)=>{
  const result=await api.request(...args);
  if(result?._v3Errors?.length)throw Error('Journal Erplain incomplet : rapprochement requis');
  return result;
 }};
 const {proof}=await readHistoricalStock(strictApi,bc,{bl,pendingBlScope:true,allowPendingSiblings:true});
 return {document:{notRequired:true,reason:'Mouvement du cycle BC/BL Erplain vérifié',bcId:String(bc.id),blId:String(bl.id),proof,checkedAt:new Date().toISOString()},stock:null};
}
