import {orderStatistics} from './order-statistics.mjs';
import {orderQuery} from './order-query.mjs';
export function orderSummaryCache(db,{read=orderStatistics,limit=50}={}){
 const entries=new Map();
 return async (params,reader=db)=>{
  const revision=(await reader.query('SELECT coalesce(max(id),0)::text revision FROM operational_events')).rows[0].revision;
  const {where,args}=orderQuery(params),key=JSON.stringify([revision,where,args]);
  let promise=entries.get(key);
  if(!promise){promise=Promise.resolve().then(()=>read(reader,params));entries.set(key,promise);while(entries.size>limit)entries.delete(entries.keys().next().value);promise.catch(()=>{if(entries.get(key)===promise)entries.delete(key);});}
  return promise;
 };
}
