import {initializeV2Bl,refreshV2Bl} from './v2-bl-read.mjs';
import {listV2} from './v2-view.mjs';
import {v2TemuReader} from './v2-tracking-read.mjs';
import {v2CarrierClient as trackingClient} from './v2-carrier-tracking.mjs';
import {aggregateParcels} from './status-policy.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';

// Deliberately separate from orders and every production creation queue.
export async function initializeV2Followup(db){await initializeV2Bl(db);await db.exec(`CREATE TABLE IF NOT EXISTS v2_followup(
 key TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'tracking_only' CHECK(mode='tracking_only'),
 source JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 events JSONB NOT NULL DEFAULT '[]', checked_at TIMESTAMPTZ, next_at TIMESTAMPTZ NOT NULL DEFAULT now(), error TEXT);
 CREATE TABLE IF NOT EXISTS v2_followup_cooldown(carrier TEXT PRIMARY KEY,until_at TIMESTAMPTZ NOT NULL);
 CREATE INDEX IF NOT EXISTS v2_followup_due ON v2_followup(next_at);
 ALTER TABLE v2_followup ADD COLUMN IF NOT EXISTS enrichment JSONB NOT NULL DEFAULT '[]';
 ALTER TABLE v2_followup ADD COLUMN IF NOT EXISTS observation JSONB NOT NULL DEFAULT '{}';
 ALTER TABLE v2_followup ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;`);}
export function normalizeV2(row){
 const s=v=>String(v??'').trim();
 const reference=s(row.reference),channel=s(row.channel).toLowerCase(),v2Id=s(row.v2Id);
 if(!reference||!['amazon','temu'].includes(channel)||!v2Id)throw Error('Référence, plateforme ou identifiant V2 absent');
 const tracking=[...new Set((Array.isArray(row.tracking)?row.tracking:s(row.tracking).split(/[;,\s]+/)).map(s).filter(Boolean))];
 if(tracking.some(t=>!/^[A-Za-z0-9-]{4,80}$/.test(t)))throw Error('Numéro de suivi invalide : '+reference);
 return {key:'v2:'+v2Id+':'+s(row.shipmentId),source:{reference,channel,v2Id,shipmentId:s(row.shipmentId),date:s(row.date),carrier:s(row.carrier).toLowerCase(),tracking,bc:s(row.bc),bcId:s(row.bcId),bl:s(row.bl),blId:s(row.blId),sourceStatus:s(row.sourceStatus)}};
}
export async function importV2(db,rows,{apply=false}={}){
 const normalized=rows.map(normalizeV2),seen=new Map();
 for(const r of normalized){if(seen.has(r.key)&&JSON.stringify(seen.get(r.key))!==JSON.stringify(r.source))throw Error('Identifiant V2 contradictoire');seen.set(r.key,r.source);}
 const report={total:seen.size,inserted:0,unchanged:0,conflicts:[],blocked:[]};
 for(const [key,source] of seen){
  const issues=await v2Issues(db,source);if(issues.busy){report.blocked.push({reference:source.reference,reason:issues.messages.join(' · ')});continue;}
  const old=(await db.query('SELECT source FROM v2_followup WHERE key=$1',[key])).rows[0];
  if(old){if(JSON.stringify(normalizeV2(old.source).source)!==JSON.stringify(source))report.conflicts.push({reference:source.reference,reason:'Import différent : données existantes conservées'});else report.unchanged++;continue;}
  if(apply){const inserted=await db.query('INSERT INTO v2_followup(key,source) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key',[key,JSON.stringify(source)]);if(!inserted.rows.length){const current=(await db.query('SELECT source FROM v2_followup WHERE key=$1',[key])).rows[0];if(current&&JSON.stringify(normalizeV2(current.source).source)===JSON.stringify(source))report.unchanged++;else report.conflicts.push({reference:source.reference,reason:'Import concurrent différent : données conservées'});continue;}}
  report.inserted++;
 }return report;
}
export async function v2Issues(db,s){
 const matches=(await db.query('SELECT id,erp_live FROM orders WHERE reference=$1 AND channel=$2',[s.reference,s.channel])).rows;
 const messages=[];let busy=false;
 if(matches.length>1)messages.push('Plusieurs commandes V3 correspondent');
 for(const o of matches){
  const active=(await db.query(`SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing')
   UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')
   UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')
   UNION ALL SELECT 1 FROM jobs WHERE order_id=$1 AND status IN ('pending','processing','running')
   UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status IN ('queued','queued_bl','creating_bl','publishing_bl','creating_stock','finalizing_bl','bl_ready','creating_label','awaiting_pdf')
   UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')
   UNION ALL SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND status IN ('purchasing','pending','uncertain')`,[o.id,s.reference])).rows;
  if(active.length){busy=true;messages.push('Reprise bloquée : traitement V3 en attente ou en cours. Attendre sa fin puis rapprocher les documents.');}
  for(const [a,b] of [[s.bcId,o.erp_live?.bc?.id],[s.blId,o.erp_live?.bl?.id]])if(a&&b&&String(a)!==String(b))messages.push('Lien Erplain différent dans V3 : données conservées');
 }
 if(!s.tracking.length)messages.push('Suivi manquant — à vérifier');
 if(!['gls','gofo'].includes(s.carrier))messages.push('Transporteur à identifier — à vérifier');
 if(!s.bcId&&!s.bc)messages.push('BC non renseigné dans le fichier');
 if(!s.blId&&!s.bl)messages.push('BL non renseigné dans le fichier');
 return {busy,messages,presentV3:matches.length>0};
}
export async function readV2Temu(read,s){
 const detail=await read('bg.order.detail.v2.get',{parentOrderSn:s.reference});
 if(detail.parentOrderMap?.parentOrderSn!==s.reference)throw Error('Identité TEMU non concordante');
 const packages=[...new Set((detail.orderList||[]).flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)))];
 if(!packages.length||packages.some(p=>!/^PK-\d+$/.test(p)))throw Error('Colis TEMU non identifié');
 const result=await read('bg.logistics.shipment.result.get',{packageSnList:packages});
 const parcels=result.packageInfoResultList||[],events=[];
 for(const tracking of s.tracking){
  const matches=parcels.filter(p=>p.trackingNumber===tracking&&packages.includes(p.packageSn));
  if(matches.length!==1)throw Error('Suivi du fichier non rapproché du colis TEMU');
  const p=matches[0],t=await read('temu.track.trackinginfo.get',{packageSn:p.packageSn});
  if(t.packageSn!==p.packageSn||t.trackingNum!==tracking)throw Error('Identité du suivi TEMU non concordante');
  for(const e of t.trackingInfo||[]){const raw=e.logisticsUpdatedAt,at=/^\d{10,13}$/.test(String(raw))?new Date(Number(raw)*(String(raw).length===10?1000:1)).toISOString():raw;if(!Number.isFinite(Date.parse(at)))throw Error('Date suivi TEMU invalide');events.push({carrier:'temu',tracking,code:e.logisticsStatus,label:e.statusText,at});}
 }
 if(!events.length)throw Error('TEMU : aucun événement de suivi');return events;
}
export function v2Worker(db,directory,{client=trackingClient(directory),temuReader=v2TemuReader(directory),shouldStop=()=>false}={}){
 let running=false;
 return {get running(){return running;},async run(){if(running||shouldStop())return;running=true;try{
  await refreshV2Bl(db,directory,{shouldStop});
  const rows=(await db.query("SELECT * FROM v2_followup WHERE mode='tracking_only' AND next_at<=now() ORDER BY (jsonb_array_length(source->'tracking')>0) DESC,next_at LIMIT 25")).rows;
  for(const row of rows){if(shouldStop())break;const s=row.source;const api=s.channel==='temu'?'temu':s.carrier;try{
   const cooldown=(await db.query('SELECT 1 FROM v2_followup_cooldown WHERE carrier=$1 AND until_at>now()',[api])).rows.length;
   if(cooldown)throw Object.assign(Error('Quota suivi atteint : reprise différée'),{retryAfter:7200});
   let observed;
   if(!s.tracking.length&&row.enrichment?.length){
    observed={api:'GLS / GOFO',parcels:row.enrichment.map(p=>({...p,api:p.carrier.toUpperCase()})),events:[],errors:[]};
    for(const p of observed.parcels){try{if((await db.query('SELECT 1 FROM v2_followup_cooldown WHERE carrier=$1 AND until_at>now()',[p.carrier])).rows.length)throw Object.assign(Error('Quota suivi atteint : reprise différée'),{retryAfter:7200});observed.events.push(...await client.read(p.carrier,'production',p.tracking));}catch(e){if(e.retryAfter)throw Object.assign(e,{v2Carrier:p.carrier});observed.errors.push(p.tracking+' : '+e.message);}}
   }else if(s.channel==='temu'){
    const hint=(await db.query("SELECT source_payload->>'mallId' mall FROM orders WHERE reference=$1 AND channel='temu' LIMIT 1",[s.reference])).rows[0]?.mall;
    try{observed=await temuReader(s,{mallHint:hint});}catch(e){if(!['gofo','gls'].includes(s.carrier)||!s.tracking.length)throw e;observed={api:s.carrier.toUpperCase(),parcels:s.tracking.map(tracking=>({tracking,carrier:s.carrier.toUpperCase(),api:s.carrier.toUpperCase()})),events:[],errors:[e.message]};}
    // A matching parcel identity from TEMU can authorize direct carrier reads, never creation.
    for(const p of observed.parcels){const carrier=/^GOFO\b/i.test(p.carrier)?'gofo':/^GLS\b/i.test(p.carrier)?'gls':(['gofo','gls'].includes(s.carrier)?s.carrier:null);
     if(carrier&&!observed.events.some(e=>e.tracking===p.tracking)){try{observed.events.push(...await client.read(carrier,'production',p.tracking));p.api=carrier.toUpperCase();}catch(e){observed.errors.push(e.message);}}
    }
   }else{
    if(!s.tracking.length)throw Error('Numéro de suivi absent du fichier : consultation API impossible');
    if(!['gls','gofo'].includes(s.carrier))throw Error('Transporteur non identifié dans le fichier : consultation API impossible');
    observed={api:s.carrier.toUpperCase(),parcels:s.tracking.map(tracking=>({tracking,carrier:s.carrier.toUpperCase(),api:s.carrier.toUpperCase()})),events:[],errors:[]};
    for(const tracking of s.tracking){try{observed.events.push(...await client.read(s.carrier,'production',tracking));}catch(e){if(e.retryAfter)throw e;observed.errors.push(e.message);}}
   }
   const events=[...new Map([...(row.events||[]),...observed.events].map(e=>[JSON.stringify([e.carrier,e.tracking,e.code,e.label,e.at]),e])).values()];
   const expected=observed.parcels.map(p=>p.tracking),complete=expected.length>0&&expected.every(t=>observed.events.some(e=>e.tracking===t));
   const error=complete?null:[...new Set(observed.errors)].join(' · ')||'API : événements manquants pour au moins un colis';
   const delivered=complete&&aggregateParcels(expected,events).status==='delivered';
   const observation={api:observed.api,parcels:observed.parcels,at:new Date().toISOString(),complete};
   await db.query("UPDATE v2_followup SET events=$2,observation=$3,checked_at=now(),last_success_at=CASE WHEN $4::boolean THEN now() ELSE last_success_at END,next_at=now()+($5::int*interval '1 second'),error=$6 WHERE key=$1",[row.key,JSON.stringify(events),JSON.stringify(observation),complete,delivered?604800:21600,error]);
  }catch(e){const delay=Math.min(86400,Math.max(7200,e.retryAfter||21600));await db.query("UPDATE v2_followup SET checked_at=now(),next_at=now()+($2::int*interval '1 second'),error=$3 WHERE key=$1",[row.key,delay,String(e.message).slice(0,500)]);
   if(e.retryAfter>=7200)await db.query("INSERT INTO v2_followup_cooldown VALUES($1,now()+interval '2 hours') ON CONFLICT(carrier) DO UPDATE SET until_at=excluded.until_at",[e.v2Carrier||api]);
  }}
 }finally{running=false;}}};
}
export async function v2Routes({p,url,req,res,db,json,user,permitted}){
 if(!p.startsWith('/api/v2-followup'))return false;
 permitted(user,['admin','manager','operator']);
 if(req.method==='POST'&&p==='/api/v2-followup/refresh'){
  const r=await db.query("UPDATE v2_followup SET next_at=now() WHERE mode='tracking_only' AND (checked_at IS NULL OR checked_at<now()-interval '5 minutes') AND NOT EXISTS(SELECT 1 FROM v2_followup_cooldown c WHERE c.carrier=CASE WHEN source->>'channel'='temu' THEN 'temu' ELSE source->>'carrier' END AND c.until_at>now()) RETURNING key");json(res,202,{queued:r.rows.length,message:'Actualisation API programmée. Aucun document ni expédition ne sera créé.'});return true;
 }
 if(req.method!=='GET'||p!=='/api/v2-followup'){json(res,405,{error:'Historique V2 : consultation uniquement'});return true;}
 const result=await listV2(db,url.searchParams);json(res,200,result);return true;
}
