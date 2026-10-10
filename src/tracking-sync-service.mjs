import {randomUUID} from 'node:crypto';
import {trackingSyncClients} from './tracking-sync-clients.mjs';
import {loadTrackingTargets,trackingSyncStore} from './tracking-sync-store.mjs';
import {saveTrackingObservation,trackingOverview,trackingHistory} from './tracking-sync-history.mjs';
import {synchronizeTracking} from './tracking-sync.mjs';
import {aggregateParcels} from './status-policy.mjs';
import {loadTrackingExport,trackingWorkbook} from './tracking-sync-export.mjs';

export function trackingSyncService(db,directory,{env=process.env,shouldStop=()=>false,clients=()=>trackingSyncClients(directory)}={}){
 let running=false;
 const store=trackingSyncStore(db);
 async function capabilities(){
  const controls=(await db.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};
  const canApply=env.ERPLAIN_LIVE_WRITES==='1'&&env.MIGRATION_PREPARATION!=='1'&&controls.lifecycle===false;
  const workerAvailable=controls['tracking-sync']!==false&&(await db.query(`SELECT 1 FROM worker_health WHERE role IN ('all','worker') AND heartbeat>now()-interval '30 seconds' AND coalesce((state->>'stopping')::boolean,false)=false AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'tasks','[]'::jsonb)) task WHERE task->>'name'='tracking-sync' AND coalesce(task->>'enabled','true')<>'false') LIMIT 1`)).rows.length>0;
  return {canApply,workerAvailable,reason:canApply?'Les statuts des BL seront synchronisés dans Erplain.':'Les suivis seront actualisés dans V3. La mise à jour Erplain n’est pas activée.'};
 }
 async function enqueue(input,user){
  if(!input||!['preview','apply'].includes(input.mode))throw Error('Mode de synchronisation invalide');
  if(input.ids!==null&&input.ids!==undefined&&(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>10000||input.ids.some(id=>typeof id!=='string'||!id||id.length>100)))throw Error('Sélection de commandes invalide');
  const options=await capabilities();
  if(!options.workerAvailable)throw Error('Le service de synchronisation est arrêté ou indisponible. Contactez un administrateur.');
  if(input.mode==='apply'&&!options.canApply)throw Error('La mise à jour Erplain n’est pas activée. Relancez une actualisation V3 uniquement.');
  const id=randomUUID();
  const inserted=await db.query(`INSERT INTO tracking_sync_runs(id,requested_by,mode,order_ids) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,[id,user.email,input.mode,input.ids?JSON.stringify([...new Set(input.ids)]):null]);
  if(inserted.rows.length)return {run:inserted.rows[0],existing:false};
  return {run:(await db.query("SELECT * FROM tracking_sync_runs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1")).rows[0],existing:true};
 }
 async function run(){
  if(running||shouldStop())return;running=true;
  let job;
  try{
   job=(await db.query(`UPDATE tracking_sync_runs SET status='running',started_at=now() WHERE status='queued' AND id=(SELECT id FROM tracking_sync_runs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
   if(!job)return;
   if(job.mode==='apply'&&!(await capabilities()).canApply)throw Error('Configuration Erplain modifiée : synchronisation interrompue');
   const wanted=job.order_ids?new Set(job.order_ids):null;
   const targets=(await loadTrackingTargets(db)).filter(t=>!wanted||wanted.has(t.orderId));
   await db.query('UPDATE tracking_sync_runs SET total=$2 WHERE id=$1',[job.id,targets.length]);
   const report=await synchronizeTracking({targets,...clients(),store,apply:job.mode==='apply',shouldStop,onRow:async(row,target)=>{
    if(row.events?.length&&!target.issue){
     try{
      await store.assertCurrent(target);
      const aggregate=aggregateParcels(row.tracking,row.events);
      if(!target.partialId&&aggregate.complete&&['shipped','delivered','not_shipped','exception'].includes(aggregate.status)){
       await db.query(`UPDATE orders SET tracking_status=$2 WHERE id=$1 AND NOT archived AND coalesce(suspension->>'active','false')<>'true' AND NOT (suspension ? 'erplainCancellation') AND tracking_status IS DISTINCT FROM $2 AND coalesce(tracking_status,'')<>'delivered' AND NOT (coalesce(tracking_status,'') IN ('shipped','in_transit') AND $2='not_shipped')`,[target.orderId,aggregate.status]);
      }
     }catch(e){row.localError=String(e.message).slice(0,400);}
    }
    await saveTrackingObservation(db,row,target,job.id);
   }});
   await db.query('UPDATE tracking_sync_runs SET status=$2,counts=$3,finished_at=now() WHERE id=$1',[job.id,shouldStop()?'interrupted':'complete',JSON.stringify(report.counts)]);
  }catch(e){if(job)await db.query("UPDATE tracking_sync_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1",[job.id,String(e.message).slice(0,500)]);else throw e;}
  finally{running=false;}
 }
 return {enqueue,run,capabilities,get running(){return running;},
  async overview(options){return {...await trackingOverview(db,options),...await capabilities()};},
  async exportExcel(options){return trackingWorkbook(await loadTrackingExport(db,options));},
  history:(key,options)=>trackingHistory(db,key,options)};
}

export async function trackingSyncRoutes({p,url,req,res,service,user,body,json,permitted}){
 if(!p.startsWith('/api/tracking-sync'))return false;
 permitted(user,['admin','manager','operator','accounting','viewer']);
 if(p==='/api/tracking-sync/export.xlsx'&&req.method==='GET'){
  const bytes=await service.exportExcel({search:url.searchParams.get('search')||'',runId:url.searchParams.get('run')||null});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="suivi-statuts-v3.xlsx"');
  res.setHeader('Cache-Control','no-store');res.end(bytes);return true;
 }
 if(p==='/api/tracking-sync'&&req.method==='GET'){
  json(res,200,await service.overview({page:url.searchParams.get('page')||1,search:url.searchParams.get('search')||'',runId:url.searchParams.get('run')||null}));return true;
 }
 if(p==='/api/tracking-sync/history'&&req.method==='GET'){
  json(res,200,await service.history(url.searchParams.get('key'),{before:url.searchParams.get('before')}));return true;
 }
 if(p==='/api/tracking-sync'&&req.method==='POST'){
  permitted(user,['admin','manager','operator']);json(res,202,await service.enqueue(await body(req),user));return true;
 }
 return false;
}
