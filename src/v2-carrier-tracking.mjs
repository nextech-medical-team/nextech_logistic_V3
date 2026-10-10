import {apiSlot} from './api-budget.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {aggregateParcels} from './status-policy.mjs';

const array=(o,keys)=>Array.isArray(o)?o:keys.map(k=>o?.[k]).find(Array.isArray)||[];
const first=(o,keys)=>keys.map(k=>o?.[k]).find(v=>v!==undefined&&v!==null&&v!=='');
export function normalizeTracking(carrier,tracking,payload){
 if(carrier==='gofo'){
  if(!Array.isArray(payload))throw Error('GOFO · API : format de suivi inattendu');
  return payload.map(e=>({carrier,tracking,code:String(e.operationMove??''),label:String(e.enContext||e.pubEsContext||''),at:e.operationTime||null}));
 }
 const parcels=array(payload,['parcels','Parcels','parcelDetails','ParcelDetails','items','Items','results','Results']);
 if(!parcels.length&&payload&&first(payload,['unitno','UnitNo','ParcelNumber','requested']))parcels.push(payload);
 const matching=parcels.filter(p=>[...['requested','Requested','parcelNumber','ParcelNumber','parcelNo','ParcelNo','parcel_id','trackId','TrackID','trackID','unitno','unitNo','UnitNo','id'].map(k=>p[k]),p.UnitDetail?.TrackID,p.UnitDetail?.ParcelNumber].some(id=>String(id)===tracking));
 if(matching.length!==1)throw Error('GLS · API : colis absent ou ambigu dans la réponse');
 const p=matching[0];let events=array(p,['events','Events','eventHistory','EventHistory','history','History','scans','Scans','statuses','Statuses']);
 if(!events.length)events=array(p.tracking,['events','Events','history','History']);
 if(!events.length)throw Error('GLS · Aucun événement de suivi reçu');
 return events.map(e=>({carrier,tracking,code:String(first(e,['code','eventCode','statusCode','StatusCode','type','State','SubState'])||''),label:String(first(e,['description','Description','eventDescription','label','name','statusText','text','Status','StateLabel','SubStateLabel'])||''),at:first(e,['eventDateTime','dateTime','timestamp','date','Date','scanDateTime','operationTime'])||null}));
}

// Dedicated read-only client: only OAuth and the two tracking GET routes exist.
export function v2CarrierClient(directory,{fetchImpl=fetch,now=()=>Date.now()}={}){
 const tokens=new Map();
 async function request(url,options){
  let r;try{r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('API suivi · Connexion impossible ou délai dépassé');}
  if(!r.ok){const e=Error('API suivi · HTTP '+r.status);e.retryAfter=r.status===429?Math.max(7200,Number(r.headers.get('retry-after'))||0):900;throw e;}
  try{return await r.json();}catch{throw Error('API suivi · Réponse JSON invalide');}
 }
 return {async read(carrier,environment,tracking){
  if(!['gls','gofo'].includes(carrier)||!['production','test'].includes(environment)||!/^[a-zA-Z0-9-]{4,80}$/.test(tracking))throw Error('Suivi · Transporteur, environnement ou numéro invalide');
  await apiSlot('tracking:'+carrier+':'+environment,1000);
  const c=JSON.parse(await readFile(path.join(directory,'carriers-'+environment+'.json'),'utf8'));
  if(carrier==='gls'){try{Object.assign(c,JSON.parse(await readFile(path.join(directory,'tracking-'+environment+'.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
  // GLS V1 endpoint supplied by the user on 2026-10-04, previously verified. V2-only fallback.
  if(carrier==='gls'){c.GLS_TRACK_TRACE_BASE_URL ||= 'https://api.gls-group.net/track-and-trace-v1';c.GLS_TRACK_TRACE_AUTH_BASE_URL ||= 'https://api.gls-group.net';}
  const base=carrier==='gofo'?c.GOFO_BASE_URL:c.GLS_TRACK_TRACE_BASE_URL;
  const allowed=environment==='production'?'https://api-eu.gofoexpress.com':'https://uat-api-eu.gofoexpress.com';
  if(carrier==='gofo'&&base!==allowed)throw Error('GOFO · URL de suivi non autorisée');
  if(carrier==='gls'&&!base)throw Error('GLS · Accès Track & Trace à configurer');
  const auth=carrier==='gofo'?base:c.GLS_TRACK_TRACE_AUTH_BASE_URL||c.GLS_AUTH_BASE_URL;
  if(carrier==='gls'&&![base,auth].every(u=>{try{const v=new URL(u);return v.protocol==='https:'&&['api.gls-group.net','api-sandbox.gls-group.net','api.gls-group.eu'].includes(v.hostname)&&!v.username&&!v.password;}catch{return false;}}))throw Error('GLS · URL Track & Trace non autorisée');
  const key=carrier+environment;let token=tokens.get(key);
  if(!token||token.until<=now()){
   const j=carrier==='gofo'?await request(base+'/openapi/oauth2/token',{method:'POST',headers:{'Content-Type':'application/json;charset=utf-8'},body:JSON.stringify({grantType:'client_credentials',appId:c.GOFO_APP_ID,appSecret:c.GOFO_APP_SECRET})}):await request(auth.replace(/\/$/,'')+'/oauth2/v1/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:c.GLS_TRACK_TRACE_CLIENT_ID||c.GLS_CLIENT_ID,client_secret:c.GLS_TRACK_TRACE_CLIENT_SECRET||c.GLS_CLIENT_SECRET}).toString()});
   token={value:carrier==='gofo'?j.accessToken:j.access_token,until:now()+(Math.max(60,Number(j.expiresIn||j.expires_in)||300)-30)*1000};if(!token.value)throw Error(carrier.toUpperCase()+' · API suivi : authentification refusée');tokens.set(key,token);
  }
  let payload;
  if(carrier==='gofo'){
   const uri='/open-api/v2/order/track/'+encodeURIComponent(tracking),date=String(now()),sign=createHmac('sha256',c.GOFO_APP_SECRET).update('date='+date+'&method=GET&uri='+uri).digest('base64');
   const j=await request(base+uri,{method:'GET',headers:{token:token.value,date,sign,'route-country':c.GOFO_ROUTE_COUNTRY||'FR'}});
   if(Number(j.code)!==200||(j.status!==undefined&&Number(j.status)!==1))throw Error('GOFO · API suivi : réponse refusée (code '+String(j.code).replace(/[^0-9]/g,'')+')');payload=j.data;
  }else{
   const uri=c.GLS_TRACK_TRACE_REFERENCES_PATH||'/tracking/simple/references';if(uri!=='/tracking/simple/references')throw Error('GLS · Route de suivi non autorisée');
   payload=await request(base.replace(/\/$/,'')+uri+'/'+encodeURIComponent(tracking)+'?showEvents=true',{method:'GET',headers:{Authorization:'Bearer '+token.value,Accept:'application/json','Accept-Language':'EN'}});
  }
  const events=normalizeTracking(carrier,tracking,payload);if(!events.length)throw Error(carrier.toUpperCase()+' · Aucun événement de suivi reçu');
  if(events.some(e=>!Number.isFinite(Date.parse(e.at))))throw Error(carrier.toUpperCase()+' · API suivi : date événement absente ou invalide');
  return events;
 }};
}

