import {shopifyObservationApi} from './shopify-observation-api.mjs';
import {connectTemuShops} from './temu-shop-clients.mjs';

export function comparePrices(bc,source){
 const valid=m=>m&&typeof m.amount!=='boolean'&&['number','string'].includes(typeof m.amount)&&/^\d+(?:\.\d+)?$/.test(String(m.amount))&&Number.isFinite(Number(m.amount))&&/^[A-Z]{3}$/.test(m.currency||'');
 if(!valid(bc)||!valid(source))throw Error('Montant ou devise absent ou invalide');
 if(bc.currency!==source.currency)throw Error('Devises différentes : comparaison impossible');
 const difference=(Math.round(Number(bc.amount)*100)-Math.round(Number(source.amount)*100))/100;
 return {bc,source,difference,status:difference===0?'same':'different'};
}

export function priceVerification(db,directory,{shopify=shopifyObservationApi(directory),connect=()=>connectTemuShops(directory)}={}){
 const countrySql="upper(coalesce(nullif(address->>'country',''),source_payload->>'country',''))";
 return {
  async options(){return {countries:(await db.query(`SELECT DISTINCT channel,${countrySql} country FROM orders WHERE archived=false AND channel IN ('shopify','temu') ORDER BY channel,country`)).rows.filter(r=>r.country)};},
  async next(input){
   if(!['shopify','temu'].includes(input.channel)||! /^[A-Z]{2}$/.test(input.country||'')||input.cursor!=null&&typeof input.cursor!=='string')throw Error('Plateforme, pays ou curseur invalide');
   const hasRange=input.start!=null||input.end!=null;
   const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
   const start=instant(input.start),end=instant(input.end);
   if(hasRange&&(!Number.isFinite(start)||!Number.isFinite(end)||start>end))throw Error('Intervalle de dates invalide');
   let order,scanCursor=input.cursor||'';
   while(!order){
    const candidates=(await db.query(`SELECT * FROM orders WHERE archived=false AND channel=$1 AND ${countrySql}=$2 AND id>$3 ORDER BY id LIMIT $4`,[input.channel,input.country,scanCursor,hasRange?100:1])).rows;
    order=candidates.find(candidate=>{if(!hasRange)return true;const date=String(candidate.source_date||'').trim();if(!/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(date))return false;const time=Date.parse(date);return Number.isFinite(time)&&time>=start&&time<=end;});
    if(order||candidates.length<100||!hasRange)break;
    scanCursor=candidates.at(-1).id;
   }
   if(!order)return {done:true};
   const result={id:order.id,reference:order.reference,country:input.country,channel:order.channel,bcId:order.erp_live?.bc?.id,checkedAt:new Date().toISOString(),status:'review'};
   try{
    const bc=order.erp_live?.bc;
    if(!bc?.id)throw Error('BC absent dans V3');
    let source;
    if(order.channel==='temu'){
     const mall=String(order.source_payload?.sourceShop||order.source_payload?.mallId||'');
     if(!mall)throw Error('Boutique TEMU non identifiée');
     const {clients}=await connect(),reader=clients.get(mall);
     if(!reader)throw Error('Boutique TEMU indisponible');
     const data=await reader.read('bg.order.amount.query',{parentOrderSn:order.reference});
     if(data?.parentOrderMap?.parentOrderSn!==order.reference)throw Error('Identité TEMU différente');
     const money=data.parentOrderMap.estimatedRevenue;
     if(!/^\d+$/.test(String(money?.amount??'')))throw Error('Montant estimé du règlement indisponible');
     source={amount:Number(money.amount)/100,currency:money.currency};
    }else{
     const response=await shopify.read('query V3PriceCheck($search:String!){orders(first:2,query:$search){nodes{id name currentTotalPriceSet{shopMoney{amount currencyCode}}} pageInfo{hasNextPage}}}',{search:'name:'+order.reference});
     if(order.source_payload?.sourceShop&&order.source_payload.sourceShop!==response.shop)throw Error('Boutique Shopify différente');
     const nodes=response.data.orders?.nodes?.filter(n=>n.name===order.reference);
     if(nodes?.length!==1||response.data.orders.pageInfo.hasNextPage)throw Error('Commande Shopify absente ou ambiguë');
     const known=order.source_payload?.id;
     if(known&&nodes[0].id!=='gid://shopify/Order/'+known)throw Error('Identité Shopify différente');
     const money=nodes[0].currentTotalPriceSet?.shopMoney;
     source={amount:money?.amount,currency:money?.currencyCode};
    }
    Object.assign(result,comparePrices({amount:bc.total,currency:bc.currency?.label},source));
   }catch(e){result.error=String(e.message).slice(0,500);}
   return {done:false,cursor:order.id,result};
  }
 };
}
