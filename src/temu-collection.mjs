import {readOrderAmounts} from './temu-margin-data.mjs';
import {createHash} from 'node:crypto';
export function temuCollector(api,{mallId,country}){
 const shop=String(mallId||'');if(!shop)throw Error('TEMU · Identité boutique absente');
 return {channel:'temu',shop,async page({cursor,since,until,createdSince=since,shouldStop=()=>false}){
  if(! /^[A-Z]{2}$/.test(country||''))throw Error('TEMU · Pays de la boutique à configurer');
  const pageNumber=cursor?Number(cursor):1;if(!Number.isInteger(pageNumber)||pageNumber<1)throw Error('TEMU · Page invalide');
  const result=await api.read('bg.order.list.v2.get',{pageNumber,pageSize:50,updateAtStart:Math.floor(Date.parse(since)/1000),updateAtEnd:Math.floor(Date.parse(until)/1000),sortby:'updateTime'});
  if(!Array.isArray(result.pageItems)||!Number.isInteger(Number(result.totalItemNum))||Number(result.totalItemNum)<0||result.pageItems.length>50)throw Error('TEMU · Pagination non vérifiable');
  const total=Number(result.totalItemNum);if(!result.pageItems.length&&total>(pageNumber-1)*50)throw Error('TEMU · Page de commandes manquante');
  const items=[],warnings=[],seen=new Set();const retain=(entry,message)=>{const payload={detail:entry,shipping:{},country,visibilityError:message};items.push({deliveryId:'incomplete:'+entry.parentOrderMap.parentOrderSn+':'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload});};for(const entry of result.pageItems){if(shouldStop())throw Error('Arrêt demandé');const ref=entry.parentOrderMap?.parentOrderSn;if(!ref||seen.has(ref))throw Error('TEMU · Référence absente ou dupliquée');seen.add(ref);const created=Number(entry.parentOrderMap?.parentOrderTime)*1000;if(Number.isFinite(created)&&created>0&&created<Date.parse(createdSince))continue;let detail;try{detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:ref});}catch(e){if(String(e.message).includes('180020006')){warnings.push({reference:ref,code:'180020006',message:'TEMU refuse la consultation de cette commande dans son état actuel'});retain(entry,String(e.message));continue;}retain(entry,String(e.message));continue;}if(detail.parentOrderMap?.parentOrderSn!==ref){retain(entry,'TEMU · Identité du détail incohérente');continue;}detail.parentOrderMap.updateTime??=entry.parentOrderMap.updateTime;
   const createdDetail=Number(detail.parentOrderMap?.parentOrderTime)*1000;if(!Number.isFinite(createdDetail)||createdDetail<=0){retain(entry,'TEMU · Date de commande absente');continue;}
   if(createdDetail<Date.parse(createdSince))continue;
   try{detail.v3Amounts={data:(await readOrderAmounts(api,ref)).data};}catch(e){detail.v3AmountsError=String(e.message||e).slice(0,450);}
   let rawShipping;try{rawShipping=await api.read('bg.order.decryptshippinginfo.get',{parentOrderSn:ref});}catch(e){if(String(e.message).includes('180020006')){warnings.push({reference:ref,code:'180020006',message:'TEMU refuse la consultation des coordonnées dans l’état actuel de la commande'});retain(detail,String(e.message));continue;}retain(detail,String(e.message));continue;}const shipping=rawShipping.result||rawShipping;const payload={detail,shipping,country};items.push({deliveryId:'poll:'+ref+':'+createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload});}
  return {items,warnings,next:pageNumber*50<total?String(pageNumber+1):null};
 }};
}
