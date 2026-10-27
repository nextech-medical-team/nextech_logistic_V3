import {shopifyCancellationWorker} from './shopify-cancellation-worker.mjs';
import {connectTemuShops} from './temu-shop-clients.mjs';
import {confirmedTemuCancellation} from './temu-cancellation-observation.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

export function cancellationOrderCreatedAt(order){
 const raw=String(order.source_date||order.source_payload?.created_at||'').trim();
 if(raw){
  const french=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{2}:\d{2}(?::\d{2})?))?$/);
  const value=french?`${french[3]}-${french[2].padStart(2,'0')}-${french[1].padStart(2,'0')}T${french[4]||'00:00:00'}`:raw;
  if(/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(value))return Date.parse(value);
 }
 const seconds=Number(order.source_payload?.detail?.parentOrderMap?.parentOrderTime||order.source_payload?.parentOrderMap?.parentOrderTime);
 return seconds>0?seconds*1000:NaN;
}

// One order per request: the browser advances the cursor only after receiving a result.
export function manualPlatformCancellation(db,directory,suspension,{shopify=shopifyCancellationWorker(db,directory),connect=()=>connectTemuShops(directory)}={}){
 // Reuse verified shop clients, never order statuses. Share initialization across
 // requests and retry failed connections instead of caching their rejection.
 let connection=null,connectionExpires=0;
 async function shops(){
  if(!connection||Date.now()>=connectionExpires){
   connectionExpires=Date.now()+5*60*1000;
   const pending=Promise.resolve().then(connect);
   connection=pending;
   pending.catch(()=>{if(connection===pending){connection=null;connectionExpires=0;}});
  }
  return connection;
 }
 async function proof(order){
  if(order.channel==='shopify'){
   const result=await shopify.cancel(order);
   if(result.error||result.state?.status!=='observed')throw Error(result.error||'Lecture Shopify indisponible');
   // A refund alone does not prove that the customer cancelled the order.
   return {cancelled:!!result.proof.cancelled_at,source:'shopify',observation:result.proof};
  }
  const mall=String(order.source_payload?.sourceShop||order.source_payload?.mallId||'');
  if(!mall)throw Error('Boutique TEMU de la commande non identifiée');
  let connected=await shops();
  // A newly configured shop may appear before the connection cache expires.
  if(!connected.clients.has(mall)){connection=null;connected=await shops();}
  const {clients,countryByMall,config}=connected,api=clients.get(mall);
  if(!api)throw Error('Boutique TEMU indisponible');
  const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:order.reference});
  const parent=detail?.parentOrderMap;
  if(parent?.parentOrderSn!==order.reference||!Number.isInteger(Number(parent.parentOrderStatus))||Number(parent.parentOrderStatus)<1||Number(parent.parentOrderStatus)>7)throw Error('Identité ou statut TEMU non confirmé');
  return {cancelled:confirmedTemuCancellation(order,detail),source:'temu',country:parent.regionName1||order.address?.country||countryByMall?.get(mall)||config?.TEMU_COUNTRIES?.[mall]||'',observation:{reference:order.reference,status:parent.parentOrderStatus,mallId:mall,observedAt:new Date().toISOString()}};
 }
 async function process(input,user,apply=false){
  if(!['admin','manager','operator'].includes(user?.role))throw Object.assign(Error('Droits insuffisants'),{status:403});
  if(input?.cursor!=null&&typeof input.cursor!=='string')throw Error('Curseur invalide');
  const channels=input?.channels??['temu','shopify'];
  if(!Array.isArray(channels)||!channels.length||channels.some(channel=>!['temu','shopify'].includes(channel)))throw Error('Plateformes invalides');
  const bounds={};
  for(const key of ['createdFrom','createdTo'])if(input?.[key]!=null&&input[key]!==''){
   if(typeof input[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input[key])||!Number.isFinite(Date.parse(input[key])))throw Error('Date de création invalide');
   bounds[key]=Date.parse(input[key]);
  }
  if(bounds.createdFrom!=null&&bounds.createdTo!=null&&bounds.createdFrom>bounds.createdTo)throw Error('La date de fin doit suivre la date de début');
  if(apply&&(typeof input?.id!=='string'||!input.id))throw Error('Commande requise');
  const order=(await db.query(apply?"SELECT * FROM orders WHERE archived=false AND id=$1 AND channel=ANY($2::text[])":"SELECT * FROM orders WHERE archived=false AND channel=ANY($2::text[]) AND id>$1 ORDER BY id LIMIT 1",[apply?input.id:input?.cursor||'',channels])).rows[0];
  if(apply&&!order)throw Error('Commande archivée ou inaccessible');
  if(!order)return {done:true};
  if(!apply&&(bounds.createdFrom!=null||bounds.createdTo!=null)){
   const created=cancellationOrderCreatedAt(order);
   if(!Number.isFinite(created)||bounds.createdFrom!=null&&created<bounds.createdFrom||bounds.createdTo!=null&&created>bounds.createdTo)return {done:false,cursor:order.id,skipped:true,unknownDate:!Number.isFinite(created)};
  }
  return withShipmentLock(async()=>{
   let result={id:order.id,reference:order.reference,channel:order.channel,country:order.address?.country||'',status:'unchanged',platformCancelled:null,v3Cancelled:order.label_status==='cancelled'||order.tracking_status==='cancelled'||order.erp_live?.bc?.status==='cancelled'};
   try{
    const observed=await proof(order);
    result.platformCancelled=observed.cancelled;
    result.country=observed.country||result.country;
    await db.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[order.id,JSON.stringify({manualPlatformCancellation:{...observed,checkedAt:new Date().toISOString(),checkedBy:user.email}})]);
    if(observed.cancelled)result.status='cancelled';
    if(observed.cancelled&&apply){
     let current=(await suspension.context(order.id)).order;
     if(current.archived)throw Error('Commande archivée pendant la vérification');
     if(!current.suspension?.active){await suspension.suspend({id:order.id,expectedVersion:current.suspension?.version||'',note:'Annulation confirmée dans '+order.channel+' par actualisation manuelle'},user);current=(await suspension.context(order.id)).order;}
     if(['shipped','delivered','in_transit','delivered_simulated'].includes(current.tracking_status)||['shipped','delivered'].includes(current.erp_live?.bl?.status))throw Error('Annulation non appliquée : le BL est déjà expédié ou livré.');
     if(current.erp_live?.bc?.id){
      await suspension.cancelErplain({id:order.id,expectedVersion:current.suspension?.version||'',confirm:true,verifyOnly:!!current.suspension?.erplainCancellation},user);
      current=(await suspension.context(order.id)).order;
      if(current.suspension?.erplainCancellation?.status!=='complete')throw Error('Annulation Erplain à vérifier');
     }
     await db.query("UPDATE orders SET label_status='cancelled',tracking_status=CASE WHEN tracking_status IN ('shipped','delivered','in_transit','delivered_simulated') THEN tracking_status ELSE 'cancelled' END WHERE id=$1",[order.id]);
     result.status='cancelled';
     result.applied=true;
     result.v3Cancelled=true;
    }
   }catch(error){result.status='review';result.error=String(error.message).slice(0,1000);}
   await db.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,apply?'order.manual_platform_cancellation':'order.manual_platform_cancellation_check',JSON.stringify(result)]);
   return {done:false,cursor:order.id,result};
  },apply?['manual-platform-cancellation:'+order.id,'stock-mutations','temu-order:'+order.reference,'suspension:'+order.id]:['manual-platform-cancellation:'+order.id]);
 }
 return {next:(input,user)=>process(input,user),apply:(input,user)=>process(input,user,true)};
}
