import {shopifyObservationApi} from './shopify-observation-api.mjs';
import {proveShopifyCancellation} from './shopify-cancellation-policy.mjs';
// Platform observations have no authority to cancel Erplain documents or stock.
export const shopifyCancellationCandidateSql=`SELECT * FROM orders WHERE channel='shopify' AND archived=false
 AND (source_payload->'shopifyCancellationSync'->>'checkedAt' IS NULL OR (source_payload->'shopifyCancellationSync'->>'checkedAt')::timestamptz<now()-interval '5 minutes')
 ORDER BY (source_payload->>'cancelled'='true' OR lower(source_payload->>'financial_status')='refunded') DESC NULLS LAST,(source_payload->'shopifyCancellationSync'->>'checkedAt')::timestamptz NULLS FIRST,received_at LIMIT 1`;

export function shopifyCancellationWorker(db,directory,{reader=shopifyObservationApi(directory)}={}){
 let running=false;
 async function source(order){
  const known=order.source_payload?.id;
  let query,variables;
  if(known){if(!/^\d+$/.test(String(known)))throw Error('Shopify · Identifiant source invalide');query='query V3CancellationOrder($id:ID!){order(id:$id){id name updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus}}';variables={id:'gid://shopify/Order/'+known};}
  else{query='query V3CancellationReference($search:String!){orders(first:10,query:$search){nodes{id name updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus} pageInfo{hasNextPage}}}';variables={search:'name:'+order.reference};}
  const response=await reader.read(query,variables);
  if(order.source_payload?.sourceShop&&order.source_payload.sourceShop!==response.shop)throw Error('Shopify · Boutique différente');
  const nodes=known?[response.data.order]:response.data.orders?.nodes?.filter(n=>n.name===order.reference);
  if(!nodes||nodes.length!==1||!nodes[0]||!known&&response.data.orders?.pageInfo?.hasNextPage!==false)throw Error('Shopify · Commande absente ou ambiguë');
  return {...proveShopifyCancellation(order,nodes[0]),shop:response.shop};
 }
 async function cancel(order){
  const previous=order.source_payload?.shopifyCancellationSync||{};
  let state={...previous,checkedAt:new Date().toISOString(),indicative:true};
  try{const proof=await source(order);state={...state,proof,status:'observed',error:null};}
  catch(e){state={...state,status:'unavailable',error:String(e.message).slice(0,600)};}
  await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[order.id,JSON.stringify({shopifyCancellationSync:state})]);
  return {cancelled:false,indicative:true,proof:state.proof,error:state.error,state};
 }
 return {get running(){return running;},cancel,async run(){if(running)return;running=true;try{const order=(await db.query(shopifyCancellationCandidateSql)).rows[0];if(order)return await cancel(order);}finally{running=false;}}};
}
