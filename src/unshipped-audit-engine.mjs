import {aggregateParcels} from './status-policy.mjs';
import {erplainObservation} from './shopify-observation.mjs';
import {auditAge,auditReference,includeAuditRow,matchAuditOrders,uncertainAuditOrders,temuAuditRow,shopifyAuditRow,diagnoseAuditRow} from './unshipped-audit-core.mjs';
import {pendingShopifyQuery} from './unshipped-audit-sources.mjs';

const message=e=>String(e?.message||e).slice(0,500);
const carrierName=(c,t)=>String(c||'').toLowerCase().startsWith('gls')?'gls':/gofo/i.test(c||'')||/^GFFR/.test(t||'')?'gofo':String(c||'').toLowerCase();
function mergeParcels(parcels){
 const byNumber=new Map();for(const p of parcels||[]){if(!p.tracking)continue;const carrier=carrierName(p.carrier,p.tracking),key=String(p.tracking),prior=byNumber.get(key);byNumber.set(key,{...prior,...p,carrier:['gls','gofo'].includes(carrier)?carrier:prior?.carrier||carrier,origin:[...new Set([...(prior?.origins||[]),p.origin].filter(Boolean))].join(' ; '),origins:[...new Set([...(prior?.origins||[]),p.origin].filter(Boolean))]});}return [...byNumber.values()];
}
export function auditTransportState(tracking,events){
 if(!Array.isArray(events)||!events.length||events.some(e=>!Number.isFinite(Date.parse(e.at))||Date.parse(e.at)>Date.now()+300000))return 'unknown';
 const physical=events.filter(e=>!(e.carrier==='temu'&&e.code==='Notification')).map(e=>{
  const failed=e.carrier==='gofo'&&(e.code==='204'&&/^Your package has been back to the sorting center,\s*type:/i.test(e.label||'')||e.code==='264'&&e.label==='Package awaiting loading back to the sender');
  return failed?{...e,code:'NOT_DELIVERED'}:e;
 });return aggregateParcels([tracking],physical).status;
}

// The only writes used by the collector are supplied through checkpoint().
// Sources expose reads; this collector has no import, shipment or status writer.
export async function collectUnshippedAudit({db,snapshot:s,sources,amazonReport,checkpoint,shouldStop=()=>false,now=()=>new Date()}){
 const stamp=()=>now().toISOString(),stop=()=>{if(shouldStop())throw Object.assign(Error('Contrôle interrompu : les résultats reçus sont conservés'),{interrupted:true});};
 const save=async()=>{s.updatedAt=stamp();await checkpoint(s);};
 const add=(row)=>{stop();if(includeAuditRow(row,s.options,s.startedAt)){row.key=row.channel+':'+row.shop+':'+row.reference;row.ageDays=auditAge(row.date,s.startedAt);row.overdue=!!row.deadline&&Date.parse(row.deadline)<Date.parse(s.startedAt);if(row.ageDays===null)row.errors.push('Date de commande non vérifiable');s.rows.push(row);}};
 const error=(scope,e)=>s.errors.push({scope,message:message(e),at:stamp()});
 let temu=[];
 try{
  if(s.options.channels.includes('temu')){
   s.phase='Lecture des boutiques TEMU';await save();
   try{const discovered=await sources.temu();temu=discovered.sources;for(const e of discovered.errors||[])error('Accès TEMU',e);if(!temu.length)throw Error('Aucune boutique TEMU accessible');}
   catch(e){stop();error('TEMU',e);}
   for(const source of temu){const cover={channel:'temu',shop:source.mall,country:source.country,complete:false,read:0,included:0};s.coverage.push(cover);const seen=new Set();
    try{let total;
     for(let page=1;page<=2000;page++){stop();s.phase='TEMU '+(source.country||source.mall)+' · page '+page;const r=await source.page(page);
      if(!Array.isArray(r?.pageItems)||r.pageItems.length>50||!Number.isInteger(Number(r.totalItemNum))||Number(r.totalItemNum)<0)throw Error('Pagination TEMU non vérifiable');
      if(total!==undefined&&total!==Number(r.totalItemNum))throw Error('Liste TEMU modifiée pendant le contrôle : relancer');total=Number(r.totalItemNum);
      for(const entry of r.pageItems){const row=temuAuditRow(entry,source.mall,source.country,stamp());if(seen.has(row.reference))throw Error('Doublon de pagination TEMU');seen.add(row.reference);add(row);}
      cover.read=seen.size;cover.included=s.rows.filter(r=>r.channel==='temu'&&r.shop===source.mall).length;await save();
      if(page*50>=total){if(seen.size!==total)throw Error('Total TEMU non concordant');cover.complete=true;break;}
      if(!r.pageItems.length||page===2000)throw Error('Pagination TEMU interrompue');
     }
    }catch(e){stop();cover.error=message(e);error('TEMU '+source.mall,e);}await save();
   }
  }
  if(s.options.channels.includes('shopify')){
   const cover={channel:'shopify',complete:false,read:0,included:0};s.coverage.push(cover);const seen=new Set(),cursors=new Set();let after=null;
   try{for(let page=1;page<=2000;page++){stop();s.phase='Shopify · page '+page;const {data,shop}=await sources.shopify.read(pendingShopifyQuery,{after}),p=data.orders;
    if(!Array.isArray(p?.nodes)||typeof p.pageInfo?.hasNextPage!=='boolean')throw Error('Pagination Shopify non vérifiable');cover.shop=shop;
    for(const n of p.nodes){const row=shopifyAuditRow(n,shop,stamp());if(seen.has(n.id))throw Error('Doublon de pagination Shopify');seen.add(n.id);add(row);}
    cover.read=seen.size;cover.included=s.rows.filter(r=>r.channel==='shopify').length;await save();
    if(!p.pageInfo.hasNextPage){cover.complete=true;break;}if(!p.nodes.length||!p.pageInfo.endCursor||cursors.has(p.pageInfo.endCursor)||page===2000)throw Error('Pagination Shopify interrompue');after=p.pageInfo.endCursor;cursors.add(after);
   }}catch(e){stop();cover.error=message(e);error('Shopify',e);}await save();
  }
  if(s.options.channels.includes('amazon')){
   stop();s.phase='Analyse du rapport Amazon';if(!amazonReport)throw Error('Rapport Amazon absent');
   s.amazonReport={id:s.options.amazonReportId,filename:amazonReport.filename,reportedAt:amazonReport.reportedAt,loadedAt:amazonReport.loadedAt,hash:amazonReport.hash,excluded:amazonReport.excluded,repeated:amazonReport.repeated};
   for(const row of amazonReport.rows)add(structuredClone(row));
   const cover={channel:'amazon',shop:amazonReport.filename,read:amazonReport.rows.length,included:s.rows.filter(r=>r.channel==='amazon').length,complete:!amazonReport.errors.length,reportedAt:amazonReport.reportedAt};s.coverage.push(cover);
   for(const e of amazonReport.errors)error('Rapport Amazon · ligne '+e.row,e.message);await save();
  }
  s.sourceCounts=Object.fromEntries(s.options.channels.map(channel=>[channel,s.coverage.filter(c=>c.channel===channel).reduce((n,c)=>n+c.read,0)]));
  stop();s.phase='Rapprochement avec V3';await save();
  const orders=(await db.query("SELECT o.id,o.channel,o.reference,o.source_reference,o.source_payload,o.erp_live,o.archived,o.issue,o.suspension,o.label_status,o.tracking_status,e.status erp_job_status,e.error erp_job_error FROM orders o LEFT JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.channel=ANY($1::text[])",[s.options.channels])).rows;
  const ids=[...new Set(s.rows.flatMap(r=>matchAuditOrders(r,orders).map(o=>o.id)))];
  const jobs=ids.length?(await db.query('SELECT order_id,carrier,status,tracking,error,environment FROM carrier_jobs WHERE order_id=ANY($1::text[])',[ids])).rows:[];
  const partials=ids.length?(await db.query("SELECT order_id,carrier,status,tracking,error,environment FROM partial_deliveries WHERE order_id=ANY($1::text[]) AND status<>'cancelled'",[ids])).rows:[];
  const extras=ids.length?(await db.query("SELECT order_id,carrier,status,tracking,environment FROM extra_parcels WHERE order_id=ANY($1::text[]) AND status<>'failed'",[ids])).rows:[];
  const resolutions=ids.length?(await db.query('SELECT DISTINCT ON(order_id) order_id,status,stage,error FROM resolution_jobs WHERE order_id=ANY($1::text[]) ORDER BY order_id,created_at DESC,id DESC',[ids])).rows:[];
  for(const row of s.rows){row.v3Uncertain=uncertainAuditOrders(row,orders).map(o=>({id:o.id,reference:o.reference}));if(row.v3Uncertain.length)row.errors.push('Boutique absente du rapprochement V3 : les fiches candidates ne prouvent ni présence, ni étiquette, ni blocage de cette commande');const matches=matchAuditOrders(row,orders);row.v3At=stamp();row.v3=matches.map(o=>{
   const cs=jobs.filter(c=>c.order_id===o.id),r=resolutions.find(r=>r.order_id===o.id),blocker=o.issue||o.erp_job_error||cs.find(c=>c.error)?.error||(['review','waiting'].includes(r?.status)?r.error:null);
   row.parcels.push(...[...cs,...partials.filter(c=>c.order_id===o.id),...extras.filter(c=>c.order_id===o.id)].filter(c=>c.environment==='production').flatMap(c=>(Array.isArray(c.tracking)?c.tracking:[c.tracking]).filter(Boolean).map(tracking=>({carrier:c.carrier,tracking,origin:'V3'}))));
   if(cs.some(c=>c.status==='ready'&&c.environment==='production'))row.labelAvailable=true;
   return {id:o.id,reference:o.reference,archived:o.archived,bc:o.erp_live?.bc,bl:o.erp_live?.bl,labelStatus:o.label_status,suspended:!!o.suspension?.active,cancelled:o.tracking_status==='cancelled'||o.erp_live?.bl?.status==='cancelled',busy:['pending','processing'].includes(o.erp_job_status)||['queued','running','waiting'].includes(r?.status),blocker};
  });row.parcels=mergeParcels(row.parcels);row.diagnosis=diagnoseAuditRow(row);}await save();
  for(let i=0;i<s.rows.length;i++){const row=s.rows[i];if(row.channel!=='temu')continue;stop();s.phase='Colis TEMU · '+(i+1)+' / '+s.rows.length;
   try{const source=temu.find(t=>String(t.mall)===row.shop),d=await source.details(row.reference);if(d.reference!==row.reference||!Number.isInteger(d.status))throw Error('Identité ou statut du détail TEMU non confirmé');
    row.sourceCode=d.status;row.sourceChanged=d.status!==2;if(d.cancellationRequested&&!row.flags.includes('pending_buyer_cancellation'))row.flags.push('pending_buyer_cancellation');row.detailAt=stamp();row.sourceListAt=row.sourceAt;row.sourceAt=row.detailAt;if(row.sourceChanged)row.sourceStatus='Statut TEMU modifié (code '+d.status+')';
    for(const p of d.packages||[])if(p.trackingNumber){row.parcels.push({carrier:p.shippingCompanyName,tracking:p.trackingNumber,packageSn:p.packageSn,origin:'API TEMU'});if(p.shippingLabelStatus===1)row.labelAvailable=true;}
    for(const e of d.errors||[])row.errors.push('TEMU : '+message(e.message));row.parcels=mergeParcels(row.parcels);
   }catch(e){stop();row.errors.push('Détail TEMU : '+message(e));}row.diagnosis=diagnoseAuditRow(row);await save();
  }
  const refs=[...new Set(s.rows.flatMap(r=>[r.reference,r.reference+'/']))];let verified=false;
  for(let i=0;i<refs.length;i+=20){stop();s.phase='Lecture Erplain · '+Math.min(i+20,refs.length)+' / '+refs.length;
   try{if(!verified){await sources.erp.verify();verified=true;}const group=refs.slice(i,i+20),found=await erplainObservation(sources.erp,group);
    for(const row of s.rows.filter(r=>group.some(g=>auditReference(g)===auditReference(r.reference)))){
     const matches=found.filter(f=>auditReference(f.reference)===auditReference(row.reference));row.bc=[...new Map([...(row.bc||[]),...matches.flatMap(m=>m.bc)].map(b=>[String(b.id),b])).values()];row.bl=[...new Map([...(row.bl||[]),...matches.flatMap(m=>m.bl)].map(b=>[String(b.id),b])).values()];row.erpAt=stamp();for(const m of matches)if(m.erpError)row.errors.push(m.erpError);row.diagnosis=diagnoseAuditRow(row);
    }
   }catch(e){stop();error('Erplain',e);for(const row of s.rows.filter(r=>refs.slice(i,i+20).some(g=>auditReference(g)===auditReference(r.reference))))row.errors.push('Erplain : '+message(e));}await save();
  }
  const unique=new Map();for(const row of s.rows){row.parcels=mergeParcels(row.parcels);for(const p of row.parcels)if(['gls','gofo'].includes(p.carrier))unique.set(p.carrier+':'+p.tracking,p);}
  const cached=unique.size?(await db.query("SELECT carrier,tracking,checked_at,events,error FROM carrier_tracking WHERE environment='production' AND tracking=ANY($1::text[])",[[...unique.values()].map(p=>p.tracking)])).rows:[];
  const hasSharedCooldown=(await db.query("SELECT to_regclass('carrier_tracking_cooldown') present")).rows[0]?.present;
  const sharedCooldowns=hasSharedCooldown?(await db.query("SELECT carrier,until_at FROM carrier_tracking_cooldown WHERE environment='production' AND until_at>now()")).rows:[];
  const blocked=new Map();let n=0;
  for(const [key,p] of unique){stop();s.phase='Suivis transporteurs · '+(++n)+' / '+unique.size;
   const result={checkedAt:stamp(),observation:'unavailable'};
   try{
    if(blocked.has(p.carrier))throw Error(blocked.get(p.carrier));
    const cooldown=sharedCooldowns.find(c=>c.carrier===p.carrier)||(await db.query('SELECT until_at FROM unshipped_audit_cooldowns WHERE carrier=$1 AND until_at>now()',[p.carrier])).rows[0];
    if(cooldown){blocked.set(p.carrier,'API en pause jusqu’au '+new Date(cooldown.until_at).toISOString());throw Error(blocked.get(p.carrier));}
    const events=await sources.tracking.read(p.carrier,'production',p.tracking);result.status=auditTransportState(p.tracking,events);result.latest=[...events].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];result.observation='live';
   }catch(e){result.error=message(e);if(/HTTP (401|403|429)/.test(result.error)){const seconds=/429/.test(result.error)?Math.max(7200,Number(e.retryAfter)||0):900;blocked.set(p.carrier,'API suspendue après refus : '+result.error);await db.query("INSERT INTO unshipped_audit_cooldowns(carrier,until_at) VALUES($1,now()+($2::int*interval '1 second')) ON CONFLICT(carrier) DO UPDATE SET until_at=greatest(unshipped_audit_cooldowns.until_at,excluded.until_at)",[p.carrier,seconds]);}}
   const prior=cached.find(c=>c.carrier===p.carrier&&c.tracking===p.tracking);if(prior)result.lastKnown={status:prior.error?'unknown':auditTransportState(p.tracking,prior.events),checkedAt:prior.checked_at,error:prior.error};
   for(const row of s.rows)for(const parcel of row.parcels)if(parcel.carrier+':'+parcel.tracking===key)Object.assign(parcel,result);await save();
  }
  for(const row of s.rows){row.diagnosis=diagnoseAuditRow(row);for(const p of row.parcels)if(!['gls','gofo'].includes(p.carrier)){p.observation='unavailable';p.error='Suivi direct non disponible pour ce transporteur dans ce module';}}
  s.status=s.errors.length||s.rows.some(r=>r.errors.length||r.parcels.some(p=>p.error))||s.coverage.some(c=>!c.complete)?'partial':'complete';s.phase='Contrôle terminé';s.finishedAt=stamp();await save();
 }catch(e){s.status=e.interrupted?'interrupted':'error';s.phase='Contrôle interrompu';error('Contrôle',e);s.finishedAt=stamp();await save();}
 return s;
}
