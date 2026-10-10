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
export function trackingClient(directory,{fetchImpl=fetch,now=()=>Date.now(),loadConfig=async file=>JSON.parse(await readFile(path.join(directory,file),'utf8'))}={}){
 const tokens=new Map();
 async function request(url,options){
  let r;try{r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('API suivi · Connexion impossible ou délai dépassé');}
  if(!r.ok){const e=Error('API suivi · HTTP '+r.status);e.retryAfter=r.status===429?Math.max(7200,Number(r.headers.get('retry-after'))||0):900;throw e;}
  try{return await r.json();}catch{throw Error('API suivi · Réponse JSON invalide');}
 }
 return {async read(carrier,environment,tracking){
  if(!['gls','gofo'].includes(carrier)||!['production','test'].includes(environment)||!/^[a-zA-Z0-9-]{4,80}$/.test(tracking))throw Error('Suivi · Transporteur, environnement ou numéro invalide');
  await apiSlot('tracking:'+carrier+':'+environment,1000);
  const c={...await loadConfig('carriers-'+environment+'.json')};
  if(carrier==='gls'){try{Object.assign(c,await loadConfig('tracking-'+environment+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  // Production endpoint supplied by the user on 2026-10-04; preserve explicit configuration.
  if(carrier==='gls'&&environment==='production'){c.GLS_TRACK_TRACE_BASE_URL ||= 'https://api.gls-group.net/track-and-trace-v1';c.GLS_TRACK_TRACE_AUTH_BASE_URL ||= 'https://api.gls-group.net';}
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

export async function initializeTracking(db){await db.exec(`CREATE TABLE IF NOT EXISTS carrier_tracking(carrier TEXT,environment TEXT,tracking TEXT,events JSONB NOT NULL DEFAULT '[]',checked_at TIMESTAMPTZ,next_at TIMESTAMPTZ NOT NULL DEFAULT now(),error TEXT,PRIMARY KEY(carrier,environment,tracking));CREATE INDEX IF NOT EXISTS tracking_due ON carrier_tracking(next_at);CREATE TABLE IF NOT EXISTS carrier_tracking_cooldown(carrier TEXT,environment TEXT,until_at TIMESTAMPTZ,PRIMARY KEY(carrier,environment));`);}
export async function trackingTargets(db,orderId,partialId=null){
 if(partialId){const d=(await db.query('SELECT carrier,tracking,status,environment FROM partial_deliveries WHERE id=$1 AND order_id=$2',[partialId,orderId])).rows[0];return (d?.tracking||[]).map(tracking=>({carrier:d.carrier?.startsWith('gls')?'gls':d.carrier,environment:d.environment||'test',tracking}));}
 const c=(await db.query('SELECT carrier,environment,tracking FROM carrier_jobs WHERE order_id=$1',[orderId])).rows[0];
 const extra=(await db.query("SELECT carrier,environment,tracking FROM extra_parcels WHERE order_id=$1 AND status<>'failed'",[orderId])).rows;
 return [...(c?.tracking||[]).map(tracking=>({...c,tracking})),...extra].map(t=>({...t,carrier:t.carrier?.startsWith('gls')?'gls':t.carrier,tracking:t.tracking||'missing:'+orderId}));
}
const trackingKey=t=>JSON.stringify([t.carrier,t.environment,t.tracking]);
export async function currentTracking(db,targets,snapshots=null){
 const events=[];const errors=[];
 for(const t of targets){const s=snapshots?snapshots.get(trackingKey(t)):(await db.query('SELECT * FROM carrier_tracking WHERE carrier=$1 AND environment=$2 AND tracking=$3',[t.carrier,t.environment,t.tracking])).rows[0];
  if(s&&!s.error&&s.checked_at&&(Date.now()-Date.parse(s.checked_at)<8*3600000||aggregateParcels([t.tracking],s.events).status==='delivered'))events.push(...s.events);else errors.push(s?.error||'Suivi à actualiser : '+t.tracking);
 }
 return {events,errors,aggregate:aggregateParcels(targets.map(t=>t.tracking),events)};
}
export function trackingWorker(db,directory,{client=trackingClient(directory)}={}){
 let running=false;
 async function targets(){
 const rows=(await db.query(`WITH eligible AS (SELECT id,partial_mode FROM orders WHERE archived=false AND (partial_mode=true OR tracking_status<>'delivered') AND (simulation=false OR partial_mode=true OR EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=orders.id AND c.environment='production' AND c.status='ready')))
 SELECT o.id order_id,null::text partial_id,c.carrier,c.environment,c.tracking FROM eligible o JOIN carrier_jobs c ON c.order_id=o.id WHERE o.partial_mode=false
 UNION ALL SELECT o.id,null::text,x.carrier,x.environment,jsonb_build_array(coalesce(x.tracking,'missing:'||o.id)) FROM eligible o JOIN extra_parcels x ON x.order_id=o.id WHERE o.partial_mode=false AND x.status<>'failed'
 UNION ALL SELECT o.id,d.id,d.carrier,d.environment,d.tracking FROM eligible o JOIN partial_deliveries d ON d.order_id=o.id WHERE o.partial_mode=true AND d.status<>'cancelled'`)).rows;
 const grouped=new Map();for(const r of rows){const key=r.order_id+':'+(r.partial_id||'');const g=grouped.get(key)||{orderId:r.order_id,partialId:r.partial_id,targets:[]};for(const tracking of r.tracking||[])g.targets.push({carrier:r.carrier?.startsWith('gls')?'gls':r.carrier,environment:r.environment||'test',tracking});grouped.set(key,g);}return [...grouped.values()];
 }
 return {
  get running(){return running;},
  async list(){return (await db.query('SELECT carrier,environment,tracking,checked_at,next_at,error FROM carrier_tracking ORDER BY error NULLS LAST,checked_at DESC NULLS LAST LIMIT 1000')).rows;},
  async request(){await db.query("UPDATE carrier_tracking t SET next_at=now() WHERE NOT EXISTS(SELECT 1 FROM carrier_tracking_cooldown c WHERE c.carrier=t.carrier AND c.environment=t.environment AND c.until_at>now())");},
  async run(){if(running)return;running=true;try{
   const groups=await targets(),all=new Map();for(const g of groups)for(const t of g.targets)if(['gls','gofo'].includes(t.carrier)&&!t.tracking.startsWith('missing:'))all.set(trackingKey(t),t);if(all.size)await db.query('INSERT INTO carrier_tracking(carrier,environment,tracking) SELECT carrier,environment,tracking FROM jsonb_to_recordset($1::jsonb) AS x(carrier text,environment text,tracking text) ON CONFLICT DO NOTHING',[JSON.stringify([...all.values()])]);
   // A small bounded batch prevents monopolizing the event loop or carrier quotas.
   const due=(await db.query('SELECT * FROM carrier_tracking WHERE next_at<=now() ORDER BY next_at LIMIT 25')).rows;
   for(const s of due){if(!all.has(trackingKey(s))){await db.query("UPDATE carrier_tracking SET next_at=now()+interval '1 day' WHERE carrier=$1 AND environment=$2 AND tracking=$3",[s.carrier,s.environment,s.tracking]);continue;}
    const cooldown=(await db.query('SELECT until_at FROM carrier_tracking_cooldown WHERE carrier=$1 AND environment=$2 AND until_at>now()',[s.carrier,s.environment])).rows[0];
    if(cooldown){await db.query('UPDATE carrier_tracking SET next_at=$4,error=$5 WHERE carrier=$1 AND environment=$2 AND tracking=$3',[s.carrier,s.environment,s.tracking,cooldown.until_at,'API suivi · Quota atteint, nouvel essai programmé']);continue;}
    try{const events=await client.read(s.carrier,s.environment,s.tracking);await db.query("UPDATE carrier_tracking SET events=$4,checked_at=now(),next_at=CASE WHEN $5::int=0 THEN 'infinity'::timestamptz ELSE now()+($5::int*interval '1 second') END,error=null WHERE carrier=$1 AND environment=$2 AND tracking=$3",[s.carrier,s.environment,s.tracking,JSON.stringify(events),trackingInterval(events,s.tracking)]);}
    catch(e){const delay=Math.min(86400,e.retryAfter||1800);await db.query("UPDATE carrier_tracking SET checked_at=now(),next_at=now()+($4::int*interval '1 second'),error=$5 WHERE carrier=$1 AND environment=$2 AND tracking=$3",[s.carrier,s.environment,s.tracking,delay,String(e.message).slice(0,300)]);if(e.retryAfter>=7200)await db.query("INSERT INTO carrier_tracking_cooldown VALUES($1,$2,now()+($3::int*interval '1 second')) ON CONFLICT(carrier,environment) DO UPDATE SET until_at=EXCLUDED.until_at",[s.carrier,s.environment,delay]);}
   }
   const snapshots=new Map((await db.query('SELECT * FROM carrier_tracking WHERE (carrier,environment,tracking) IN (SELECT carrier,environment,tracking FROM jsonb_to_recordset($1::jsonb) AS x(carrier text,environment text,tracking text))',[JSON.stringify([...all.values()])])).rows.map(t=>[trackingKey(t),t]));
   for(const g of groups){if(!g.targets.length)continue;const snapshot=await currentTracking(db,g.targets,snapshots);
    // Partial BLs are independent. Never declare a whole order delivered from a single partial BL.
    if(!g.partialId&&!snapshot.errors.length&&['shipped','delivered','not_shipped','exception'].includes(snapshot.aggregate.status))await db.query("UPDATE orders SET tracking_status=$2 WHERE id=$1 AND tracking_status IS DISTINCT FROM $2 AND (tracking_status<>'delivered' OR $2='delivered')",[g.orderId,snapshot.aggregate.status]);
    if(due.some(s=>g.targets.some(t=>t.carrier===s.carrier&&t.environment===s.environment&&t.tracking===s.tracking)))await db.query('UPDATE document_lifecycle SET requested=true WHERE order_id=$1 AND partial_id IS NOT DISTINCT FROM $2::text AND locked=false',[g.orderId,g.partialId]);
   }
  }finally{running=false;}}
 };
}

export function trackingInterval(events,tracking){const status=aggregateParcels([tracking],events).status;return status==='delivered'?0:status==='exception'?1800:status==='shipped'?7200:21600;}
