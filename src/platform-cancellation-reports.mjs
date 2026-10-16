import {randomUUID} from 'node:crypto';

export async function initializePlatformCancellationReports(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS platform_cancellation_reports(
  id TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),status TEXT NOT NULL DEFAULT 'checking',
  scope JSONB NOT NULL,scan_complete BOOLEAN NOT NULL DEFAULT false,issues JSONB NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS platform_cancellation_report_rows(
   report_id TEXT REFERENCES platform_cancellation_reports(id),order_id TEXT NOT NULL,
   checked JSONB NOT NULL,applied JSONB,PRIMARY KEY(report_id,order_id));`);
}

export function platformCancellationReports(db,service){
 async function get(id){
  const report=(await db.query('SELECT * FROM platform_cancellation_reports WHERE id=$1',[id])).rows[0];
  if(!report)throw Error('Rapport introuvable');
  return report;
 }
 async function process(input,user,apply=false){
  let reportId=input.reportId;
  if(!reportId){
   if(apply||input.cursor)throw Error('Rapport requis');
   reportId=randomUUID();
   await db.query('INSERT INTO platform_cancellation_reports(id,owner,scope) VALUES($1,$2,$3)',[reportId,user.email,JSON.stringify({channels:input.channels||['temu','shopify'],createdFrom:input.createdFrom,createdTo:input.createdTo})]);
  }
  const report=await get(reportId);
  if(apply){
   if(!report.scan_complete)throw Error('Vérification incomplète');
   const row=(await db.query('SELECT * FROM platform_cancellation_report_rows WHERE report_id=$1 AND order_id=$2',[reportId,input.id])).rows[0];
   if(!row||row.checked.platformCancelled!==true)throw Error('Annulation absente du rapport');
   await db.query("UPDATE platform_cancellation_reports SET status='applying',updated_at=now() WHERE id=$1",[reportId]);
  }else if(report.scan_complete)throw Error('Vérification déjà terminée');
  const response=await service[apply?'apply':'next']({...input,...report.scope},user);
  if(response.result){
   if(apply)await db.query('UPDATE platform_cancellation_report_rows SET applied=$3 WHERE report_id=$1 AND order_id=$2',[reportId,response.result.id,JSON.stringify(response.result)]);
   else await db.query('INSERT INTO platform_cancellation_report_rows(report_id,order_id,checked) VALUES($1,$2,$3) ON CONFLICT(report_id,order_id) DO UPDATE SET checked=excluded.checked',[reportId,response.result.id,JSON.stringify(response.result)]);
  }
  await db.query("UPDATE platform_cancellation_reports SET updated_at=now(),scan_complete=scan_complete OR $2,status=CASE WHEN $2 THEN 'ready' ELSE status END WHERE id=$1",[reportId,!apply&&response.done]);
  return {...response,reportId};
 }
 return {
  next:(input,user)=>process(input,user),apply:(input,user)=>process(input,user,true),
  history:async()=>({rows:(await db.query('SELECT id,owner,created_at,updated_at,status FROM platform_cancellation_reports ORDER BY created_at DESC LIMIT 25')).rows}),
  async read(id){const report=await get(id);const rows=(await db.query('SELECT checked,applied FROM platform_cancellation_report_rows WHERE report_id=$1 ORDER BY order_id',[id])).rows;return {...report,results:rows.map(r=>({...r.checked,...r.applied})),checks:rows.map(r=>r.checked)};},
  async finish(input){
   await get(input.reportId);
   if(!Array.isArray(input.issues)||input.issues.length>1000||input.issues.some(v=>typeof v!=='string'||v.length>2000))throw Error('Alertes invalides');
   await db.query("UPDATE platform_cancellation_reports SET issues=$2,updated_at=now(),status=CASE WHEN NOT scan_complete THEN 'interrupted' WHEN status='applying' THEN 'complete' ELSE status END WHERE id=$1",[input.reportId,JSON.stringify(input.issues)]);
   return {saved:true};
  }
 };
}
