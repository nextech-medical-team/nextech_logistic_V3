import {randomUUID} from 'node:crypto';
import {auditOptions,activeAudit,auditView,parseAmazonAuditReport} from './unshipped-audit-core.mjs';
import {collectUnshippedAudit} from './unshipped-audit-engine.mjs';
import {unshippedSources} from './unshipped-audit-sources.mjs';

export async function initializeUnshippedAudit(db,{recover=false}={}){
 await db.exec(`CREATE TABLE IF NOT EXISTS unshipped_audit_reports(id TEXT PRIMARY KEY,filename TEXT NOT NULL,hash TEXT NOT NULL,reported_at TIMESTAMPTZ NOT NULL,uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),created_by TEXT NOT NULL,report JSONB NOT NULL,UNIQUE(hash,reported_at));
 CREATE TABLE IF NOT EXISTS unshipped_audit_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,created_by TEXT NOT NULL,state JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS unshipped_audit_one_active ON unshipped_audit_runs((true)) WHERE status IN ('queued','running');
 CREATE TABLE IF NOT EXISTS unshipped_audit_cooldowns(carrier TEXT PRIMARY KEY,until_at TIMESTAMPTZ NOT NULL);`);
 if(recover)await db.query("UPDATE unshipped_audit_runs SET status='interrupted',state=state||jsonb_build_object('status','interrupted','phase','Serveur redémarré : résultats conservés, relancer le contrôle','finishedAt',now()),updated_at=now() WHERE status='running'");
}
async function readRun(db,id){return (await db.query(id?'SELECT state FROM unshipped_audit_runs WHERE id=$1':'SELECT state FROM unshipped_audit_runs ORDER BY created_at DESC,id DESC LIMIT 1',id?[id]:[])).rows[0]?.state||null;}
const saveRun=(db,s)=>db.query('UPDATE unshipped_audit_runs SET status=$2,state=$3,updated_at=now() WHERE id=$1',[s.id,s.status,JSON.stringify(s)]);
export function unshippedAuditService(db,directory,{shouldStop=()=>false,sourceFactory=unshippedSources,workerAvailable,now=()=>new Date()}={}){
 let running=false;
 const available=workerAvailable||(async()=>{
  const controls=(await db.query("SELECT value FROM settings WHERE key='background_tasks'")).rows[0]?.value||{};if(controls['unshipped-audit']===false)return false;
  return (await db.query("SELECT 1 FROM worker_health WHERE role IN ('all','worker') AND heartbeat>now()-interval '30 seconds' AND coalesce((state->>'stopping')::boolean,false)=false AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'tasks','[]')) t WHERE t->>'name'='unshipped-audit' AND coalesce((t->>'enabled')::boolean,true)) LIMIT 1")).rows.length>0;
 });
 return {
  async reports(){return (await db.query('SELECT id,filename,reported_at,uploaded_at,jsonb_array_length(report->\'rows\') count,jsonb_array_length(report->\'errors\') errors FROM unshipped_audit_reports ORDER BY uploaded_at DESC,id DESC LIMIT 30')).rows;},
  async upload(input,user){
   const report=await parseAmazonAuditReport(input,now()),id=randomUUID();
   const result=await db.query('INSERT INTO unshipped_audit_reports(id,filename,hash,reported_at,created_by,report) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(hash,reported_at) DO UPDATE SET filename=unshipped_audit_reports.filename RETURNING id',[id,report.filename,report.hash,report.reportedAt,user.email,JSON.stringify(report)]);
   return {id:result.rows[0].id,filename:report.filename,reportedAt:report.reportedAt,count:report.rows.length,excluded:report.excluded,repeated:report.repeated,errors:report.errors,issues:report.rows.filter(r=>r.errors.length).map(r=>({reference:r.reference,errors:r.errors}))};
  },
  async start(input,user){
   const options=auditOptions(input);
   return db.withLocks(['unshipped-audit-start'],async()=>{
    const existing=(await db.query("SELECT state FROM unshipped_audit_runs WHERE status IN ('queued','running') LIMIT 1")).rows[0]?.state;
    if(existing)return {status:'running',id:existing.id,existing:true};
    if(!await available())throw Error('Le worker de contrôle est indisponible ou désactivé');
    const previous=await readRun(db);if(previous&&+now()-Date.parse(previous.startedAt)<60000)return {status:'cooldown',error:'Attendre une minute avant un nouveau contrôle'};
    if(options.amazonReportId&&!(await db.query('SELECT 1 FROM unshipped_audit_reports WHERE id=$1',[options.amazonReportId])).rows.length)throw Error('Rapport Amazon introuvable');
    const state={id:randomUUID(),status:'queued',phase:'En attente du contrôle',options,startedAt:now().toISOString(),updatedAt:now().toISOString(),rows:[],coverage:[],errors:[]};
    await db.query('INSERT INTO unshipped_audit_runs(id,status,created_by,state) VALUES($1,$2,$3,$4)',[state.id,state.status,user.email,JSON.stringify(state)]);return {status:'queued',id:state.id};
   });
  },
  read:id=>readRun(db,id),
  async history(){return (await db.query("SELECT id,status,created_at,updated_at,state->'options' options,jsonb_array_length(state->'rows') count FROM unshipped_audit_runs ORDER BY created_at DESC,id DESC LIMIT 20")).rows;},
  async run(){if(running||shouldStop())return;running=true;
   try{await db.withLocks(['unshipped-audit-worker'],async()=>{
    const s=(await db.query("SELECT state FROM unshipped_audit_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1")).rows[0]?.state;if(!s||shouldStop())return;
    s.status='running';await saveRun(db,s);
    const amazonReport=s.options.amazonReportId?(await db.query('SELECT report FROM unshipped_audit_reports WHERE id=$1',[s.options.amazonReportId])).rows[0]?.report:null;
    try{await collectUnshippedAudit({db,snapshot:s,sources:sourceFactory(directory,{shouldStop}),amazonReport,checkpoint:state=>saveRun(db,state),shouldStop,now});}
    catch(e){s.status='error';s.phase='Contrôle arrêté';s.errors.push({scope:'Contrôle',message:String(e.message).slice(0,500)});s.finishedAt=now().toISOString();await saveRun(db,s);}
   });}finally{running=false;}
  }
 };
}
const exportHeaders=['Plateforme','Boutique','Commande','Date commande','Ancienneté jours','Échéance expédition','État plateforme','Source','Lecture source','Présence V3','État V3','BC Erplain','BL Erplain','Étiquette disponible','Suivis','Diagnostic','Blocage V3','Erreurs / limites','État du contrôle','Début du contrôle','Seuil ancienneté jours'];
function csv(snapshot,query){
 const rows=auditView(snapshot,{...query,page:1,pageSize:Math.max(1,snapshot.rows.length)}).rows;
 const cell=v=>{let x=String(v??'');if(/^[\s]*[=+@-]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"';};
 return '\uFEFF'+[exportHeaders,...rows.map(r=>[r.channel,r.shop,r.reference,r.date,r.ageDays,r.deadline,r.sourceStatus,r.sourceKind,r.sourceAt,r.v3?.length?'Présente':'Absente',(r.v3||[]).map(o=>o.labelStatus).join(' | '),(r.bc||[]).map(b=>b.label+' : '+b.status).join(' | '),(r.bl||[]).map(b=>b.label+' : '+b.status).join(' | '),r.labelAvailable?'Oui':'Non confirmée',(r.parcels||[]).map(p=>p.tracking+' : '+(p.observation==='live'?p.status:'Non confirmé')+' ; '+(p.checkedAt||'')+(p.lastKnown?' ; dernier état V3 '+p.lastKnown.status+' au '+p.lastKnown.checkedAt:'')).join(' | '),r.diagnosis,(r.v3||[]).map(o=>o.blocker).filter(Boolean).join(' | '),[...(r.errors||[]),...(r.parcels||[]).map(p=>p.error).filter(Boolean),...(r.channel==='amazon'?['État Amazon déclaré par le rapport daté du '+r.sourceAt+' ; aucune lecture API Amazon']:[])].join(' | '),snapshot.status,snapshot.startedAt,snapshot.options?.minAgeDays])].map(r=>r.map(cell).join(';')).join('\r\n');
}
export async function unshippedAuditRoutes({p,url,req,res,service,user,permitted,body,json}){
 if(!p.startsWith('/api/unshipped-audit'))return false;
 if(p==='/api/unshipped-audit/reports'&&req.method==='GET'){json(res,200,{reports:await service.reports()});return true;}
 if(p==='/api/unshipped-audit/reports'&&req.method==='POST'){permitted(user,['admin','manager','operator']);json(res,200,await service.upload(await body(req),user));return true;}
 if(p==='/api/unshipped-audit/history'&&req.method==='GET'){json(res,200,{runs:await service.history()});return true;}
 if(p==='/api/unshipped-audit'&&req.method==='POST'){permitted(user,['admin','manager','operator']);const result=await service.start(await body(req),user);json(res,result.status==='cooldown'?429:202,result);return true;}
 if(['/api/unshipped-audit','/api/unshipped-audit/export'].includes(p)&&req.method==='GET'){
  const id=url.searchParams.get('id'),s=await service.read(id);if(id&&!s){json(res,404,{error:'Contrôle introuvable'});return true;}
  const query={channel:url.searchParams.get('channel')||'',search:(url.searchParams.get('search')||'').slice(0,200),diagnosis:(url.searchParams.get('diagnosis')||'').slice(0,200),page:url.searchParams.get('page')};
  if(p.endsWith('/export')){if(!s){json(res,404,{error:'Aucun contrôle à exporter'});return true;}res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="commandes-non-expediees-'+s.startedAt.slice(0,10)+'.csv"');res.end(csv(s,query));}
  else json(res,200,auditView(s,query));return true;
 }
 json(res,405,{error:'Méthode non autorisée'});return true;
}
