import {shopifyCancellationWorker} from './shopify-cancellation-worker.mjs';
import {connectTemuShops} from './temu-shop-clients.mjs';
import {confirmedTemuCancellation} from './temu-cancellation-observation.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

// One order per request: the browser advances the cursor only after receiving a result.
export function manualPlatformCancellation(db,directory,suspension,{shopify=shopifyCancellationWorker(db,directory),connect=()=>connectTemuShops(directory)}={}){
 async function proof(order){
  if(order.channel==='shopify'){
   const result=await shopify.cancel(order);
   if(result.error||result.state?.status!=='observed')throw Error(result.error||'Lecture Shopify indisponible');
   // A refund alone does not prove that the customer cancelled the order.
   return {cancelled:!!result.proof.cancelled_at,source:'shopify',observation:result.proof};
  }
  const mall=String(order.source_payload?.sourceShop||order.source_payload?.mallId||'');
  if(!mall)throw Error('Boutique TEMU de la commande non identifiée');
  const {clients}=await connect(),api=clients.get(mall);
  if(!api)throw Error('Boutique TEMU indisponible');
  const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:order.reference});
  const parent=detail?.parentOrderMap;
  if(parent?.parentOrderSn!==order.reference||!Number.isInteger(Number(parent.parentOrderStatus))||Number(parent.parentOrderStatus)<1||Number(parent.parentOrderStatus)>7)throw Error('Identité ou statut TEMU non confirmé');
  return {cancelled:confirmedTemuCancellation(order,detail),source:'temu',observation:{reference:order.reference,status:parent.parentOrderStatus,mallId:mall,observedAt:new Date().toISOString()}};
 }
 return {async next(input,user){
  if(!['admin','manager','operator'].includes(user?.role))throw Object.assign(Error('Droits insuffisants'),{status:403});
  if(input?.cursor!=null&&typeof input.cursor!=='string')throw Error('Curseur invalide');
  const channels=input?.channels??['temu','shopify'];
  if(!Array.isArray(channels)||!channels.length||channels.some(channel=>!['temu','shopify'].includes(channel)))throw Error('Plateformes invalides');
  const order=(await db.query("SELECT * FROM orders WHERE archived=false AND channel=ANY($2::text[]) AND id>$1 ORDER BY id LIMIT 1",[input?.cursor||'',channels])).rows[0];
  if(!order)return {done:true};
  return withShipmentLock(async()=>{
   let result={id:order.id,reference:order.reference,channel:order.channel,status:'unchanged'};
   try{
    const observed=await proof(order);
    await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[order.id,JSON.stringify({manualPlatformCancellation:{...observed,checkedAt:new Date().toISOString(),checkedBy:user.email}})]);
    if(observed.cancelled){
     let current=(await suspension.context(order.id)).order;
     if(current.archived)throw Error('Commande archivée pendant la vérification');
     if(!current.suspension?.active){await suspension.suspend({id:order.id,expectedVersion:current.suspension?.version||'',note:'Annulation confirmée dans '+order.channel+' par actualisation manuelle'},user);current=(await suspension.context(order.id)).order;}
     if(['shipped','delivered','in_transit','delivered_simulated'].includes(current.tracking_status))throw Error('Commande expédiée ou livrée : rapprochement physique requis');
     if(current.erp_live?.bc?.id){
      await suspension.cancelErplain({id:order.id,expectedVersion:current.suspension?.version||'',confirm:true,verifyOnly:!!current.suspension?.erplainCancellation},user);
      current=(await suspension.context(order.id)).order;
      if(current.suspension?.erplainCancellation?.status!=='complete')throw Error('Annulation Erplain à vérifier');
     }
     await db.query("UPDATE orders SET label_status='cancelled',tracking_status=CASE WHEN tracking_status IN ('shipped','delivered','in_transit','delivered_simulated') THEN tracking_status ELSE 'cancelled' END WHERE id=$1",[order.id]);
     result.status='cancelled';
    }
   }catch(error){result.status='review';result.error=String(error.message).slice(0,1000);}
   await db.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,'order.manual_platform_cancellation',JSON.stringify(result)]);
   return {done:false,cursor:order.id,result};
  },['manual-platform-cancellation:'+order.id,'stock-mutations','temu-order:'+order.reference,'suspension:'+order.id]);
 }};
}
