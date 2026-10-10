import {apiSlot} from './api-budget.mjs';
import {relayConfig,readThroughRelay} from './temu-read-relay.mjs';
import {createHash,randomBytes} from 'node:crypto';
export function documentHeaders(config,url){const u=new URL(url);if(u.origin!=='https://openapi-b-eu.temu.com'||!/^\/pkg-label-eu\/[^/]+\/[^/]+\.pdf$/.test(u.pathname)||u.username||u.password)return undefined;const headers={'toa-app-key':config.TEMU_APP_KEY,'toa-access-token':config.TEMU_ACCESS_TOKEN,'toa-random':randomBytes(16).toString('hex'),'toa-timestamp':String(Math.floor(Date.now()/1000))};const assembled=Object.keys(headers).sort().map(k=>k+headers[k]).join('');headers['toa-sign']=createHash('md5').update(config.TEMU_APP_SECRET+assembled+config.TEMU_APP_SECRET).digest('hex').toUpperCase();return headers;}
const reads=new Set(['bg.open.accesstoken.info.get','bg.local.mall.info.get','bg.order.decryptshippinginfo.get','temu.track.trackinginfo.get','bg.order.list.v2.get','bg.order.detail.v2.get','bg.order.amount.query','bg.logistics.warehouse.list.get','bg.logistics.shippingservices.get','bg.logistics.shipment.result.get','bg.logistics.shipment.document.get','bg.logistics.shipment.v2.get']);
export function temuApi(config,{fetchImpl=fetch,relay=relayConfig(),relayRead=readThroughRelay}={}){
 async function relayRequest(payload,purchase=false){try{return await relayRead(relay,payload);}catch(e){if(purchase||!String(e.message).includes('(SSH 255)'))throw e;await new Promise(resolve=>setTimeout(resolve,500));return relayRead(relay,payload);}}
 async function call(type,data={},purchase=false){
  await apiSlot('temu:'+String(config.TEMU_APP_KEY||'')+':'+createHash('sha256').update(String(config.TEMU_ACCESS_TOKEN||'')).digest('hex').slice(0,16),500);

  if(!(reads.has(type)||(purchase&&type==='bg.logistics.shipment.create')))throw new Error('Opération TEMU interdite');
  if(purchase&&relay&&relay.purchaseEnabled!==true)throw new Error('TEMU · Relais temporaire en lecture seule : aucun achat autorisé');
  for(const k of ['TEMU_APP_KEY','TEMU_APP_SECRET','TEMU_ACCESS_TOKEN'])if(!config[k])throw new Error(k+' absent de la configuration privée TEMU');
  const payload={app_key:config.TEMU_APP_KEY,access_token:config.TEMU_ACCESS_TOKEN,data_type:'JSON',timestamp:String(Math.floor(Date.now()/1000)),type,...data};
  const assembled=Object.keys(payload).sort().map(k=>k+(typeof payload[k]==='object'?JSON.stringify(payload[k]):String(payload[k]))).join('');
  const sign=createHash('md5').update(config.TEMU_APP_SECRET+assembled+config.TEMU_APP_SECRET).digest('hex').toUpperCase();
  let j;if(relay){j=await relayRequest({...payload,sign},purchase);}else{
  const r=await fetchImpl('https://openapi-b-eu.temu.com/openapi/router',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,sign})});
  if(!r.ok)throw new Error('TEMU HTTP '+r.status);
  j=await r.json();}
  if(!j.success||(j.errorCode!==undefined&&![0,1000000].includes(Number(j.errorCode))))throw new Error('TEMU refuse l’opération : '+String(j.errorCode||'inconnu')+' '+String(j.errorMsg||'').slice(0,300));
  if(j.result===undefined)throw new Error('Résultat TEMU absent');return j.result;
 }
 return {canBuy:!relay||relay.purchaseEnabled===true,read:(type,data)=>call(type,data),buy:data=>call('bg.logistics.shipment.create',data,true),
  async pdf(url){const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!/(^|\.)(temu\.com|kwcdn\.com|pddpic\.com|pinduoduo\.com)$/.test(u.hostname))throw new Error('Hôte du PDF TEMU non autorisé');
   const headers=documentHeaders(config,u);if(relay&&headers){const r=await relayRequest({type:'nextech.pdf.get',url:u.href,headers});const bytes=Buffer.from(r?.result?.pdf||'','base64');if(r?.success!==true||bytes.length>5242880||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('TEMU · PDF du relais invalide');return bytes;}
   const r=await fetchImpl(u,{headers:documentHeaders(config,u),redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('TEMU · PDF refusé (HTTP '+r.status+')');const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>20*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('PDF TEMU invalide');return bytes;}
 };
}
