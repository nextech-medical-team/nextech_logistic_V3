import {initializeEquivalenceImports,equivalenceImportService} from './equivalence-import.mjs';
import {initializeTemuCatchup,temuCatchupWorker} from './temu-catchup-worker.mjs';
import {initializeMovementWatch,movementWatchWorker,movementWatchdog,movementWatchStatus} from './movement-watch.mjs';
import {loadEnvFile} from 'node:process';
import {suspensionGuardRequired} from './suspension-route-policy.mjs';
import {initializeOrderRecheckMonitor,orderRecheckMonitor} from './order-recheck-monitor.mjs';
import {initializeTrackingSync} from './tracking-sync-history.mjs';
import {trackingSyncService,trackingSyncRoutes} from './tracking-sync-service.mjs';
import {initializeOrderSuspension,orderSuspensionService} from './order-suspension.mjs';
import {initializeImportCorrections,importCorrections} from './import-corrections.mjs';
import {restoreCancelledDeliveryStock} from './cancelled-delivery-stock.mjs';
import {refreshErplainDocuments} from './erplain-documents-sync.mjs';
import {projectCurrentDiagnostics} from './current-order-diagnostics.mjs';
import {selectProblemOrders,paginateProblemOrders} from './problem-typology.mjs';
import {currentProblemClassifier} from './problem-typology-reader.mjs';
import {initializeStockResumeWatch,stockResumeWorker} from './stock-resume-watch.mjs';
import {initializeShopifyObservation,shopifyObservationWorker,shopifyObservationRoutes} from './shopify-observation.mjs';
import {readingService} from './temu-reading.mjs';
import {initializeEquivalences,equivalenceApi} from './equivalence-catalog.mjs';
import {initializeV2Followup,v2Worker,v2Routes} from './v2-followup.mjs';
import {currentPartialSkuPdf} from './label-sku-copy.mjs';
import {initializeSkuCopies} from './label-sku-copy.mjs';
import {labelAttachment} from './label-attachment.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {initializeManualReview} from './erplain-manual-validation.mjs';
import {initializeTemuSync,temuSyncJobs} from './temu-sync-jobs.mjs';
import {taskControls} from './background-controls.mjs';
import {assertLiveCapacity} from './live-capacity.mjs';
import {initializeProcessingClock,processingRows,setOrderPriority} from './order-priority.mjs';
import {importAuthorization} from './import-authorization.mjs';
import {partialAllocationSql} from './partial-allocation.mjs';
import {initializeReadServiceJobs,readServiceJobs} from './read-service-jobs.mjs';
import {initializeAppSchema} from './schema-startup.mjs';
import {orderSummaryCache} from './order-summary-cache.mjs';
import {orderPageDetails} from './order-page-details.mjs';
import {operationalMaintenance} from './operational-maintenance.mjs';
import {initializeLabelDownloads,configureExportStore,labelDownloadWorker} from './label-downloads.mjs';
import {initializeMarketplaceInbox,marketplaceInbox} from './marketplace-inbox.mjs';
import {shopifyCollector,loadShopifyConfig,marketplaceCollector,shopifyWebhook} from './marketplace-collection.mjs';
import {runtimeConfig,initializeOperations,createRuntime} from './runtime.mjs';
import {configureApiBudget} from './api-budget.mjs';
import {configureShipmentLocks} from './shipment-lock.mjs';
import {installEventTriggers,liveEvents} from './live-events.mjs';
import {trackingAudit} from './tracking-audit.mjs';
import {trackingWorker} from './carrier-tracking.mjs';
import {initializeLifecycle,lifecycleWorker} from './lifecycle-worker.mjs';
import {initializeErplainRefresh,erplainRefreshService} from './erplain-refresh.mjs';
import {temuLocalService} from './temu-local.mjs';
import {initializeTemuAutomaticPurchase,temuAutomaticPurchaseWorker} from './temu-automatic-purchase.mjs';
import {createMarginsService} from './margins-service.mjs';
import {initializeProcurement,procurementService} from './procurement.mjs';
import {initializeResolutions,resolutionService} from './problem-resolution.mjs';
import {orderStatistics} from './order-statistics.mjs';
import {initializeCorrections,correctionWorker,correctionsApi} from './problem-corrections.mjs';
import {erplainStatusSync} from './erplain-status.mjs';
import {initializeComments2005,extraParcelWorker,comments2005Api} from './comments-2005.mjs';
import {managerSql} from './account-manager.mjs';
import {fullWeightSync} from './full-weight-sync.mjs';
import {equivalentService} from './equivalents.mjs';
import {labelTools} from './label-tools.mjs';
import {initializeTemuShipping,temuShipping} from './temu-shipping.mjs';
import {temuApi} from './temu-api.mjs';
import {temuRoutes} from './temu-routes.mjs';
import {initializePartialDeliveries,partialService} from './partial-deliveries.mjs';
import {erplainProgress} from './erplain-progress.mjs';
import {reconcileAutomaticTest} from './automatic-test.mjs';
import {initializeStocks,stockSync} from './stock-sync.mjs';

import {initializeErplainLive,erplainLiveWorker,queueErplainLive} from './erplain-live-workflow.mjs';
import {interruptedErplainRecovery} from './erplain-interrupted.mjs';

import {loadRouting,validateRouting} from './routing.mjs';

import {orderQuery} from './order-query.mjs';

import http from 'node:http';

import {initializeCarrierJobs,createCarrierWorkers,queueCarrierLabels} from './carrier-jobs.mjs';

import {workspaceApi} from './workspace-api.mjs';

import {readFile,mkdir,writeFile} from 'node:fs/promises';

import {fileURLToPath} from 'node:url';

import path from 'node:path';

import {randomBytes,timingSafeEqual} from 'node:crypto';

import {openDatabase} from './db.mjs';

import {createUser,login,authenticate,tokenHash} from './auth.mjs';

import {ROLES} from './domain.mjs';

import {importMapping,importOrders,previewOrders} from './imports.mjs';
import {temuExcelImportRoutes} from './temu-excel-import.mjs';

import {createDemo,runJobs,refreshTracking} from './workflow.mjs';

import {createCatalogSync} from './erplain-readonly.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

try{loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}

const directory=process.env.DATA_DIR||path.join(root,'data');await mkdir(directory,{recursive:true});

const config=runtimeConfig();
const db=await openDatabase({directory:path.join(directory,'postgres'),url:process.env.DATABASE_URL});
db.recoverInterrupted=config.background;
const releaseLeader=config.background?await db.acquireLeader():async()=>{};
await initializeAppSchema(db,[initializeCarrierJobs,initializeComments2005,initializeTemuShipping,initializeStocks,initializeErplainLive,initializePartialDeliveries,initializeCorrections,initializeTemuAutomaticPurchase,initializeResolutions,initializeProcurement,initializeLifecycle,initializeErplainRefresh,initializeMarketplaceInbox,initializeLabelDownloads,initializeReadServiceJobs,initializeProcessingClock],{background:config.background});
await db.withLocks(['schema'],()=>initializeSkuCopies(db));
await db.withLocks(['schema'],()=>initializeEquivalences(db));
await db.withLocks(['schema'],()=>initializeEquivalenceImports(db));
await db.withLocks(['schema'],()=>initializeStockResumeWatch(db));
await db.withLocks(['schema'],()=>initializeV2Followup(db));
await db.withLocks(['schema'],()=>initializeShopifyObservation(db));
await db.withLocks(['schema'],()=>initializeManualReview(db));
const importApprovals=importAuthorization(db);
await db.withLocks(['schema'],()=>initializeImportCorrections(db));
const importCorrectionService=importCorrections(db,erplainAccount(directory,'source'));
await db.withLocks(['schema'],()=>initializeOrderSuspension(db));
const suspensionService=orderSuspensionService(db,erplainAccount(directory,'live'));
configureApiBudget(db);configureShipmentLocks(db);const cachedOrderSummary=orderSummaryCache(db);
await db.withLocks(['schema'],()=>initializeTrackingSync(db));
if(config.background)await db.query("UPDATE tracking_sync_runs SET status='interrupted',finished_at=now(),error='Serveur redémarré : les résultats déjà reçus sont conservés. Relancez la synchronisation.' WHERE status='running'");
await db.withLocks(['schema'],()=>initializeMovementWatch(db));
const runtime=createRuntime(db,{role:config.role});await runtime.start();
await db.withLocks(['schema'],()=>initializeOrderRecheckMonitor(db,{afterPublication:config.background}));
let taskSequence=0;
function backgroundInterval(fn,ms,name){return config.background?runtime.schedule(name||'background-'+(++taskSequence),fn,ms):{unref(){}};}
const statusSync=trackingSyncService(db,process.env.CREDENTIALS_DIR||directory,{shouldStop:()=>runtime.stopping});
backgroundInterval(()=>statusSync.run(),1000,'tracking-sync');
const v2Followup=v2Worker(db,directory,{shouldStop:()=>runtime.stopping});backgroundInterval(()=>v2Followup.run(),10000,'v2-followup');
const temuReading=readingService(db,directory);
const shopifyObservation=shopifyObservationWorker(db,directory,{shouldStop:()=>runtime.stopping});backgroundInterval(()=>shopifyObservation.run(),10000,'shopify-observation');
const events=liveEvents(db,{authenticate});if(config.http)await events.start();


await db.query("UPDATE orders SET archived=true WHERE reference=ANY($1::text[]) AND simulation=true",[['DEMO-e1d14bef','DEMO-bae34637','DEMO-ed2acf71']]);

let temuService=null;try{const config=JSON.parse(await readFile(path.join(directory,'temu-production.json'),'utf8'));if(config.TEMU_APP_KEY&&config.TEMU_APP_SECRET&&config.TEMU_ACCESS_TOKEN)temuService=temuShipping(db,temuApi(config));}catch{}

const corrections=correctionWorker(db,directory);const correctionTimer=backgroundInterval(()=>corrections.run(),1700,'corrections');correctionTimer.unref();

const resolutions=resolutionService(db,directory,{refreshTemuDiagnostic:reference=>temuLocal.diagnose(reference)});const resolutionTimer=backgroundInterval(()=>resolutions.run(),900,'resolutions');resolutionTimer.unref();
backgroundInterval(()=>runtime.enabled('resolutions')?resolutions.followWaiting():undefined,1000,'resolutions-followup').unref();
const equivalenceImports=equivalenceImportService(db,directory);
backgroundInterval(()=>runtime.enabled('resolutions')?equivalenceImports.run():undefined,1200,'equivalence-imports');
const procurement=procurementService(db,directory);const purchaseTimer=backgroundInterval(()=>procurement.run(),2500,'procurement');purchaseTimer.unref();
const fbmConfirmationPath=path.join(directory,'margin-amazon-fbm-confirmation.json');
let fbmConfirmation;try{fbmConfirmation=JSON.parse(await readFile(fbmConfirmationPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;fbmConfirmation={confirmedAt:new Date().toISOString(),reason:'Utilisateur : commandes Amazon présentes expédiées par notre entrepôt (FBM)',orderIds:(await db.query("SELECT id FROM orders WHERE channel='amazon' AND archived=false")).rows.map(r=>r.id)};await writeFile(fbmConfirmationPath,JSON.stringify(fbmConfirmation,null,2),{flag:'wx'});}
const margins=await createMarginsService(db,{confirmedAmazonIds:fbmConfirmation.orderIds,confirmedAmazonImportsFbm:true});margins.get().then(r=>console.log(JSON.stringify({marginDiagnostics:{total:r.rows.length,negative:r.rows.filter(x=>x.status==='negative').length,incomplete:r.rows.filter(x=>x.status==='incomplete').length,positive:r.rows.filter(x=>x.status==='positive').length}}))).catch(e=>console.error('Diagnostic marges : '+e.message));
const lifecycle=lifecycleWorker(db,directory);const tracking=trackingWorker(db,directory);await db.query("UPDATE carrier_tracking t SET next_at=now() WHERE error IS NOT NULL AND NOT EXISTS(SELECT 1 FROM carrier_tracking_cooldown c WHERE c.carrier=t.carrier AND c.environment=t.environment AND c.until_at>now())");const trackingTimer=backgroundInterval(async()=>{try{await tracking.run();const totals=(await db.query('SELECT count(*)::int total,count(*) FILTER(WHERE checked_at IS NOT NULL)::int checked FROM carrier_tracking')).rows[0],errors=(await db.query('SELECT carrier,error FROM carrier_tracking WHERE error IS NOT NULL LIMIT 30')).rows,counts=(await db.query('SELECT carrier,count(*)::int n FROM carrier_tracking WHERE checked_at IS NOT NULL AND error IS NULL GROUP BY carrier')).rows;await writeFile(path.join(directory,'tracking-progress.json'),JSON.stringify({at:new Date().toISOString(),running:tracking.running,...totals,errors,success:Object.fromEntries(counts.map(r=>[r.carrier,r.n]))}));}catch(e){console.error('Suivi transporteurs : '+e.message);}},10000,'tracking');trackingTimer.unref();const lifecycleTimer=backgroundInterval(()=>lifecycle.run().catch(e=>console.error('Cycle Erplain LIVE : '+e.message)),5000,'lifecycle');lifecycleTimer.unref();
const documentStatuses=erplainStatusSync(db,directory);
const stocks=stockSync(db,directory),erpWorker=erplainLiveWorker(db,directory);
const rechecks=orderRecheckMonitor(db,erplainAccount(directory,'live'),{canResume:()=>runtime.enabled('automatic-preparation')&&runtime.enabled('erplain-preparation'),enabled:()=>!runtime.stopping&&runtime.enabled('resolutions')});
backgroundInterval(()=>rechecks.runLocal().catch(e=>console.error('Recontrôle local : '+e.message)),5000,'order-rechecks');
backgroundInterval(()=>rechecks.runExternal().catch(e=>console.error('Recontrôle externe : '+e.message)),60000,'order-rechecks-external');
const movementWatch=movementWatchWorker(db,directory,{shouldStop:()=>runtime.stopping});
backgroundInterval(()=>movementWatch.run(),1000,'movement-watch');
backgroundInterval(()=>movementWatchdog(db),300000,'movement-watchdog');
const stockResume=stockResumeWorker(db,directory,{enabled:()=>!runtime.stopping&&runtime.enabled('stock-resume')&&runtime.enabled('erplain-preparation')&&runtime.enabled('automatic-preparation')});
backgroundInterval(()=>stockResume.run(),30000,'stock-resume');
const interruptedErplain=interruptedErplainRecovery(db,directory,{shouldStop:()=>runtime.stopping});
backgroundInterval(()=>interruptedErplain.run(),15000,'erplain-interrupted-recovery');
const erplainRefresh=erplainRefreshService(db,directory);const erplainRefreshTimer=backgroundInterval(()=>erplainRefresh.run(),1200,'erplain-refresh');erplainRefreshTimer.unref();
const temuLocal=temuLocalService(db,directory);
const temuAutoPurchase=temuAutomaticPurchaseWorker(db,temuLocal,margins,{refreshPreparation:id=>refreshErplainDocuments(db,erplainAccount(directory,'source'),id),enabled:()=>!runtime.stopping&&runtime.enabled('temu-automatic-purchase')&&runtime.enabled('temu-logistics')&&runtime.enabled('automatic-preparation')});
backgroundInterval(()=>temuAutoPurchase.run(),30000,'temu-automatic-purchase');
await db.withLocks(['schema'],()=>initializeTemuSync(db));
const temuSync=temuSyncJobs(db,temuLocal,{shouldStop:()=>runtime.stopping});
backgroundInterval(()=>temuSync.run(),1000,'temu-logistics');
configureExportStore(process.env.EXPORT_DIR||path.join(directory,'exports'));
backgroundInterval(()=>operationalMaintenance(db),60000,'maintenance');
const exportWorker=labelDownloadWorker(db);backgroundInterval(()=>exportWorker.run(),1000,'exports');
const receiptWorker=marketplaceInbox(db);
const collection=marketplaceCollector(db,async()=>{const sources=[];for(const [channel,load] of [['shopify',async()=>[shopifyCollector(await loadShopifyConfig(directory))]],['temu',()=>temuLocal.collectors()]]){try{sources.push(...await load());}catch(e){if(e.code!=='ENOENT')await db.query("INSERT INTO marketplace_cursors(channel,shop,error) VALUES($1,'configuration','Connexion à configurer : réception indisponible') ON CONFLICT(channel,shop) DO UPDATE SET error=excluded.error",[channel]);}}return sources;},{shouldStop:()=>runtime.stopping});
await initializeTemuCatchup(db);
const temuCatchup=temuCatchupWorker(db,()=>temuLocal.collectors(),{shouldStop:()=>runtime.stopping});
backgroundInterval(()=>temuCatchup.run(),2000,'marketplace-temu-catchup');
backgroundInterval(()=>collection.run(),2000,'marketplace-collection');backgroundInterval(()=>receiptWorker.run(),1000,'marketplace-inbox');

const erpTimer=backgroundInterval(()=>erpWorker.run(),1000,'erplain-preparation');erpTimer.unref();

await db.exec("ALTER TABLE mappings ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''; ALTER TABLE mappings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();");

let productionConfig=null;try{productionConfig=JSON.parse(await readFile(path.join(directory,'carriers-production.json'),'utf8'));}catch{}
let partialConfig=null;try{partialConfig=JSON.parse(await readFile(path.join(directory,'carriers-test.json'),'utf8'));}catch{}
let carrierWorkers=null;try{carrierWorkers=createCarrierWorkers(db,partialConfig,{productionConfig});}catch{}
const extras=extraParcelWorker(db,{testConfig:partialConfig,productionConfig});const extraTimer=backgroundInterval(()=>extras.run(),1200,'extra-parcels');extraTimer.unref();
const partialWorker=partialService(db,directory,{carrierConfig:productionConfig,testConfig:partialConfig});
const partialTimer=backgroundInterval(()=>partialWorker.run(),1500,'partials');partialTimer.unref();

for(const carrier of ['gls','gofo'])backgroundInterval(async()=>{if(carrierWorkers)await carrierWorkers.run(carrier);},1000,'carrier-'+carrier);

const catalog=createCatalogSync(db,directory); const allWeights=fullWeightSync(db,directory),equivalents=equivalentService(db,directory);

await db.query(`UPDATE jobs SET status='pending',available_at=now() WHERE kind='label' AND status='blocked'`);

const readerJobs=readServiceJobs(db,{catalog,weights:allWeights,stocks},{enabled:kind=>runtime.enabled('read-'+kind)});backgroundInterval(()=>readerJobs.run(),1000,'read-services');
if(config.background)readerJobs.enqueue('catalog').catch(()=>{});

const catalogTimer=backgroundInterval(()=>readerJobs.enqueue('catalog'),6*60*60*1000,'catalog-periodic');catalogTimer.unref();

const progressTimer=backgroundInterval(async()=>{try{const progress={at:new Date().toISOString(),lifecycleRunning:lifecycle.running,trackingRunning:tracking.running,resolutions:(await db.query("SELECT o.reference,r.status,r.stage,r.error,o.erp_live,c.status carrier_status,c.error carrier_error FROM resolution_jobs r JOIN orders o ON o.id=r.order_id LEFT JOIN carrier_jobs c ON c.order_id=o.id WHERE r.created_at>now()-interval '1 day' ORDER BY r.created_at DESC LIMIT 30")).rows,automatic:(await db.query("SELECT value FROM settings WHERE key='automatic_live'")).rows[0]?.value?.enabled||false,erp:(await db.query('SELECT status,count(*)::int AS count FROM erp_live_jobs GROUP BY status')).rows,carriers:(await db.query('SELECT carrier,environment,status,count(*)::int AS count FROM carrier_jobs GROUP BY carrier,environment,status')).rows,partials:(await db.query('SELECT status,count(*)::int AS count FROM partial_deliveries GROUP BY status')).rows,documents:Number((await db.query('SELECT count(*)::int AS count FROM carrier_documents')).rows[0].count),errors:(await db.query("SELECT o.id,o.reference,o.channel,o.erp_live,j.status,j.error FROM erp_live_jobs j JOIN orders o ON o.id=j.order_id WHERE j.status='review'")).rows,carrierErrors:(await db.query("SELECT o.id,o.reference,c.carrier,c.status,c.error FROM carrier_jobs c JOIN orders o ON o.id=c.order_id WHERE c.status IN ('failed','review')")).rows};await writeFile(path.join(directory,'processing-progress.json'),JSON.stringify(progress,null,2));}catch{}},3000,'progress');progressTimer.unref();

const {port,host,origin}=config;

const setupToken=randomBytes(32).toString('hex');

const countUsers=async()=>Number((await db.query('SELECT count(*) AS n FROM users')).rows[0].n);

if(!await countUsers())await writeFile(path.join(directory,'premiere-connexion.txt'),`Ouvrir ce lien local pour créer votre compte administrateur :\n${origin}/#setup=${setupToken}\nCe lien expire au redémarrage du serveur.\n`,{mode:0o600});

let running=false;const timer=backgroundInterval(async()=>{if(running)return;running=true;try{await runJobs(db,15,{carriersEnabled:!!carrierWorkers});if(runtime.enabled('automatic-preparation'))await reconcileAutomaticTest(db);}catch{console.error('Traitement local interrompu ; reprise au prochain passage.');}finally{running=false;}},700,'order-workflow');

timer.unref();

const failures=new Map();

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};

async function body(req){if(req.parsedBody!==undefined)return req.parsedBody;let size=0;const limit=['/api/import/temu/preview','/api/import/temu/confirm'].includes(req.url?.split('?')[0])?20:17;const parts=[];for await(const part of req){size+=part.length;if(size>limit*1024*1024)throw new Error('Requête trop volumineuse');parts.push(part);}return req.parsedBody=JSON.parse(Buffer.concat(parts).toString()||'{}');}

function permitted(user,roles){if(!roles.includes(user.role)){const e=new Error('Droits insuffisants');e.status=403;throw e;}}

const operational=['admin','manager','operator'];

async function audit(user,action,detail={}){await db.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,action,JSON.stringify(detail)]);}

let activeRequests=0,shuttingDown=false;
const server=http.createServer(async(req,res)=>{
 if(shuttingDown){json(res,503,{error:'Redémarrage en cours : réessayer dans quelques instants'});return;}activeRequests++;

  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');

  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

  try{

    if(!config.hosts.has(req.headers.host)){json(res,403,{error:'Hôte interdit'});return;}

    const url=new URL(req.url,origin),p=url.pathname;

    if(!['GET','POST'].includes(req.method)){json(res,405,{error:'Méthode interdite'});return;}

    if(process.env.MIGRATION_PREPARATION==='1'&&p==='/webhooks/shopify'){json(res,423,{error:'Imports suspendus : attente du GO'});return;}
    if(p==='/webhooks/shopify'&&req.method==='POST'){await shopifyWebhook(req,res,db,directory);return;}
    if(req.method==='POST'){

      if(!config.origins.has(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'Origine ou format interdit'});return;}

    }

    if(req.method==='GET'&&/^\/flags\/[A-Z]{2}\.svg$/.test(p)){try{const bytes=await readFile(path.join(root,'public',p.slice(1)));res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});res.end(bytes);}catch{res.writeHead(404);res.end();}return;}
    if(req.method==='GET'&&['/','/movement-watch.js','/platform-observations.css','/tracking-sync.js','/temu-excel-import.js','/tracking-sync.css','/order-suspension.js','/order-suspension.css','/lecture-shopify.js','/temu-reading.js','/temu-reading.css','/equivalence-catalog.js','/equivalence-import.js','/v2-followup.js','/label-sku-copy.js','/migration-preparation.js','/signup.js','/live-events.js','/import-safety.js','/order-priority.js','/erplain-refresh.js','/lifecycle-ui.js','/comments-1030.js','/margins.js','/purchases.js','/comments-october.js','/diagnostics.js','/compact-problems.js','/shopify-rules.js','/comments-1651.js','/comments-2005.js','/problem-corrections.js','/import-corrections.js','/app.js','/workspace.js','/review.js','/partial.js','/temu.js','/improvements.js','/parity-audit.json','/style.css'].includes(p)){

      const file=p==='/'?'index.html':p.slice(1);res.setHeader('Content-Type',p.endsWith('.json')?'application/json':p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(await readFile(path.join(root,'public',file)));return;

    }

    if(p==='/api/status'&&req.method==='GET'){json(res,200,{setupNeeded:!(await countUsers()),mode:config.secure?'hosted':'local',version:'0.2.0-robustness'});return;}

    if(p==='/api/setup'&&req.method==='POST'){

      const b=await body(req),t=Buffer.from(String(b.token||'')),expected=Buffer.from(setupToken);

      if(t.length!==expected.length||!timingSafeEqual(t,expected))throw new Error('Lien dâ€™initialisation invalide');

      await db.transaction(async tx=>{await tx.exec('LOCK TABLE users IN EXCLUSIVE MODE');if(Number((await tx.query('SELECT count(*) AS n FROM users')).rows[0].n))throw new Error('Compte administrateur déjà créé');await createUser(tx,b.email,b.password,'admin');});

      json(res,201,{ok:true});return;

    }

    if(p==='/api/signup'&&req.method==='POST'){
      const key='signup:'+req.socket.remoteAddress,now=Date.now(),record=failures.get(key)||{n:0,start:now};
      if(now-record.start>600000){record.n=0;record.start=now;}
      if(record.n>=5){json(res,429,{error:'Trop de tentatives d’inscription. Réessayez dans dix minutes.'});return;}
      record.n++;failures.set(key,record);
      try{
        const b=await body(req);
        await db.transaction(async tx=>{
          const created=await createUser(tx,b.email,b.password,'admin');
          await tx.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[created.email,'user.self_registered',JSON.stringify({role:'admin'})]);

        });
        json(res,201,{ok:true});
      }catch(e){json(res,400,{error:e.code==='23505'?'Un compte existe déjà avec cet email. Connectez-vous.':e.message});}
      return;
    }

    if(p==='/api/login'&&req.method==='POST'){

      const now=Date.now(),remote=req.socket.remoteAddress,record=failures.get(remote)||{n:0,start:now};if(now-record.start>600000){record.n=0;record.start=now;}

      if(record.n>=10){json(res,429,{error:'Trop de tentatives. Réessayer dans dix minutes.'});return;}

      try{const b=await body(req),result=await login(db,b.email,b.password);failures.delete(remote);res.setHeader('Set-Cookie',`v3session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.secure?'; Secure':''}`);json(res,200,result.user);}catch(e){record.n++;failures.set(remote,record);json(res,401,{error:'Identifiants incorrects'});}return;

    }

    const user=await authenticate(db,req.headers.cookie);if(!user){json(res,401,{error:'Connexion requise'});return;}
    if(await temuReading.routes(req,res,url,user,json))return;
    if(p==='/api/import/preview'&&req.method==='POST'){
      const b=await body(req);permitted(user,operational);
      if(typeof b.content!=='string'||typeof b.filename!=='string')throw new Error('Fichier absent');
      const preview=await previewOrders(db,Buffer.from(b.content,'base64'),b.filename,b.kind,{shopifyReader:async()=>shopifyCollector(await loadShopifyConfig(directory))});json(res,200,{...preview,readOnly:process.env.MIGRATION_PREPARATION==='1'});return;
    }

    if(process.env.MIGRATION_PREPARATION==='1'){
      if(p==='/api/import'&&req.method==='POST'){
        const b=await body(req);
        if(b.kind!=='mapping'){json(res,423,{error:'Seul l’import du mapping produits est autorisé. Les commandes restent suspendues jusqu’au GO.'});return;}
        permitted(user,['admin','manager']);
        if(typeof b.content!=='string'||typeof b.filename!=='string')throw Error('Fichier absent');
        const result=await importMapping(db,Buffer.from(b.content,'base64'),b.filename);
        await audit(user,'mapping.import',{rows:result.rows,errors:result.errors.length});
        json(res,200,result);return;
      }
      if(req.method==='POST'&&p!=='/api/logout'){json(res,423,{error:'Préparation LIVE : imports, écritures et traitements suspendus jusqu’au GO'});return;}
      if(/^\/api\/(temu|imports?|demo|workspace|erplain\/refresh|erplain\/live\/)/.test(p)){json(res,423,{error:'Commandes et imports suspendus jusquâ€™au GO'});return;}
      if(p==='/api/erplain/live-reference'&&req.method==='GET'){
        const snapshot=JSON.parse(await readFile(path.join(directory,'live-reference-status.json'),'utf8'));
        json(res,200,{...snapshot,importsEnabled:false,writesEnabled:false,mode:'live-readonly-preparation'});return;
      }
    }


    if(p==='/api/orders/suspension'&&req.method==='GET'){json(res,200,await suspensionService.context(url.searchParams.get('id')));return;}
    if(['/api/orders/suspend','/api/orders/reactivate','/api/orders/cancel-erplain'].includes(p)&&req.method==='POST'){
      permitted(user,operational);const b=await body(req);const method=p.endsWith('/suspend')?'suspend':p.endsWith('/reactivate')?'reactivate':'cancelErplain';json(res,200,await suspensionService[method](b,user));return;
    }
    // Every explicit order mutation checks the persisted suspension, including old browser tabs.
    if(suspensionGuardRequired(p,req.method)){
      const b=await body(req),ids=[b.id,b.orderId,...(Array.isArray(b.ids)?b.ids:[])].filter(x=>typeof x==='string'),refs=[b.reference,...(Array.isArray(b.references)?b.references:[])].filter(x=>typeof x==='string');
      if(ids.length||refs.length){const stopped=(await db.query("SELECT reference FROM orders WHERE (id=ANY($1::text[]) OR reference=ANY($2::text[]) OR id IN (SELECT order_id FROM partial_deliveries WHERE id=ANY($1::text[])) OR id IN (SELECT order_id FROM extra_parcels WHERE id=ANY($1::text[]))) AND (coalesce(suspension->>'active','false')='true' OR suspension ? 'erplainCancellation')",[ids,refs])).rows;if(stopped.length)throw Error('Commande suspendue ou annulation ERPLAIN enregistrée : '+stopped.map(o=>o.reference).join(', '));}
    }
    if(p==='/api/erplain/live-reference'&&req.method==='GET'){const snapshot=JSON.parse(await readFile(path.join(directory,'live-reference-status.json'),'utf8'));json(res,200,{...snapshot,importsEnabled:true,writesEnabled:process.env.ERPLAIN_LIVE_WRITES==='1',mode:'live-active'});return;}
    if(p==='/api/marketplaces/automatic'&&req.method==='GET'){permitted(user,['admin','manager']);json(res,200,{configuration:(await db.query("SELECT value FROM settings WHERE key='marketplace_automatic'")).rows[0]?.value||{enabled:false},sources:(await db.query('SELECT channel,shop,watermark,last_success,error FROM marketplace_cursors')).rows,receipts:(await db.query('SELECT channel,status,count(*)::int n FROM marketplace_receipts GROUP BY channel,status')).rows});return;}
    if(p==='/api/marketplaces/automatic'&&req.method==='POST'){permitted(user,['admin']);const b=await body(req);if(typeof b.enabled!=='boolean'||!Number.isFinite(Date.parse(b.since)))throw Error('Activation et date de début de réception requises');await db.query("INSERT INTO settings(key,value) VALUES('marketplace_automatic',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify({...((await db.query("SELECT value FROM settings WHERE key='marketplace_automatic'")).rows[0]?.value||{}),enabled:b.enabled,since:new Date(Math.max(Date.parse(b.since),Date.parse('2026-10-06T08:45:34Z'))).toISOString(),lookbackDays:7})]);await audit(user,'marketplace.automatic.configured',{enabled:b.enabled,since:b.since});json(res,200,{ok:true});return;}
    if(p==='/api/events'&&req.method==='GET'){events.connect(req,res);return;}
    if(p==='/api/operations/tasks'&&['GET','POST'].includes(req.method)){permitted(user,['admin']);const input=req.method==='POST'?await body(req):undefined;json(res,200,{tasks:await taskControls(db,input)});return;}
    if(p==='/api/movement-watch'&&req.method==='GET'){permitted(user,['admin','manager','operator']);json(res,200,await movementWatchStatus(db));return;}
    if(p==='/api/operations/health'&&req.method==='GET'){permitted(user,['admin','manager']);const workers=(await db.query("SELECT role,heartbeat,state FROM worker_health WHERE heartbeat>now()-interval '30 seconds' ORDER BY heartbeat DESC")).rows;json(res,200,{database:db.kind,workers});return;}

    if(p==='/api/live-estimates'&&req.method==='GET'){
      let state={};try{state=JSON.parse(await readFile(path.join(directory,'estimate-transfer/results.json'),'utf8'));}catch{}
      json(res,200,{rows:Object.entries(state).map(([sourceId,s])=>({sourceId,source:s.sourceLabel,target:s.estimate?.label,verified:!!s.verified,error:s.error||null}))});return;
    }
    if(p==='/api/processing-status'&&req.method==='GET'){
      json(res,200,{resolutions:(await db.query("SELECT o.reference,r.status,r.stage,r.error,o.erp_live,c.status carrier_status,c.error carrier_error FROM resolution_jobs r JOIN orders o ON o.id=r.order_id LEFT JOIN carrier_jobs c ON c.order_id=o.id WHERE r.created_at>now()-interval '1 day' ORDER BY r.created_at DESC LIMIT 30")).rows,automatic:(await db.query("SELECT value FROM settings WHERE key='automatic_live'")).rows[0]?.value?.enabled||false,erp:(await db.query('SELECT status,count(*)::int AS count FROM erp_live_jobs GROUP BY status')).rows,carriers:(await db.query('SELECT carrier,environment,status,count(*)::int AS count FROM carrier_jobs GROUP BY carrier,environment,status')).rows});return;
    }
    if(p==='/api/erplain/live-capacity'&&req.method==='GET'){
      const state=(await db.query("SELECT value FROM settings WHERE key='erplain_live_capacity'")).rows[0]?.value;
      const missing=Number((await db.query("SELECT count(*) n FROM orders WHERE reference NOT LIKE 'DEMO-%' AND erp_live->'bc'->>'id' IS NULL")).rows[0].n);
      json(res,200,{current:state?.current??null,limit:null,remaining:null,missing,checkedAt:state?.checkedAt});return;
    }
    if(p.startsWith('/api/purchases/')){permitted(user,['admin','manager']);
      if(p==='/api/purchases/jobs'&&req.method==='GET'){json(res,200,{rows:await procurement.list()});return;}
      if(req.method==='POST'){const b=await body(req);
        if(p==='/api/purchases/preview'){if(typeof b.content!=='string'||typeof b.filename!=='string'||!b.filename.toLowerCase().endsWith('.xlsx'))throw Error('Fichier XLSX requis');json(res,200,await procurement.preview(Buffer.from(b.content,'base64'),b.filename,user));return;}
        if(p==='/api/purchases/recheck'){json(res,200,await procurement.recheck(b,user));return;}
        if(p==='/api/purchases/alias'){json(res,200,await procurement.saveAlias(b,user));return;}
        if(p==='/api/purchases/queue'){json(res,202,await procurement.queue(b,user));return;}
      }
    }
    if(p==='/api/margins'&&req.method==='GET'){permitted(user,['admin','manager','operator']);json(res,200,await margins.get());return;}
    if(await labelTools({p,req,res,db,user,body,json,audit,permitted}))return;
    if(await shopifyObservationRoutes({p,url,req,res,db,json,user,permitted}))return;
    if(await v2Routes({p,url,req,res,db,json,user,permitted}))return;
    if(await temuRoutes({p,url,req,res,db,service:temuService,local:temuLocal,sync:temuSync,user,json,body,permitted,audit}))return;
    if(await trackingSyncRoutes({p,url,req,res,service:statusSync,user,body,json,permitted}))return;
    if(p==='/api/tracking/current'&&req.method==='POST'){permitted(user,['admin','manager','operator']);const b=await body(req);const primary=(await db.query('SELECT environment,carrier,tracking FROM carrier_jobs WHERE order_id=$1',[b.id])).rows[0];const additional=(await db.query("SELECT environment,carrier,tracking FROM extra_parcels WHERE order_id=$1 AND status='ready'",[b.id])).rows;const targets=[...(primary?.tracking||[]).map(tracking=>({...primary,tracking})),...additional];const target=targets.find(t=>t.tracking===b.tracking);if(!target)throw Error('Ce numéro ne correspond plus au suivi actuel');if(target.carrier!=='gofo'){json(res,200,{tracking:target.tracking,url:'https://gls-group.com/FR/fr/suivi-colis?match='+encodeURIComponent(target.tracking)});return;}const result=await extras.tracking(target.environment,target.tracking);await audit(user,'tracking.gofo.read',{orderId:b.id,tracking:target.tracking});json(res,200,{tracking:target.tracking,result});return;}
    if(p==='/api/tracking/automatic'&&req.method==='GET'){json(res,200,{rows:await tracking.list(),running:tracking.running});return;}
    if(p==='/api/lifecycle'&&req.method==='GET'){json(res,200,{rows:await lifecycle.list(),running:lifecycle.running});return;}
    if(p==='/api/lifecycle/resume'&&req.method==='POST'){permitted(user,['admin','manager','operator']);await tracking.request();const r=await lifecycle.request();await audit(user,'erplain.live.lifecycle.request',{});json(res,202,r);return;}
    if(p==='/api/erplain/status/refresh'&&req.method==='POST'){permitted(user,['admin','manager','operator']);const r=await documentStatuses.refresh();await audit(user,'erplain.live.status.read',{});json(res,200,r);return;}
    if(await comments2005Api({p,url,req,res,db,user,body,json,permitted,audit}))return;
    if(await equivalenceImports.routes({p,url,req,res,user,body,json,permitted}))return;
    if(await resolutions.routes({p,url,req,res,user,body,json,permitted}))return;
    if(await correctionsApi({p,url,req,res,db,user,body,json,permitted,directory}))return;
    if(await equivalenceApi({p,url,req,res,db,user,body,json,permitted,api:erplainAccount(directory,'source'),directory}))return;
    if(await workspaceApi({p,url,req,res,db,user,body,json,permitted,audit,catalog,carrierConfigured:!!carrierWorkers&&!!productionConfig}))return;

    if(p==='/api/weights/all'&&req.method==='GET'){json(res,200,await readerJobs.snapshot('weights',()=>allWeights.status()));return;}
    if(p==='/api/weights/all'&&req.method==='POST'){permitted(user,['admin','manager']);await audit(user,'erplain.weights.full_read');json(res,202,await readerJobs.enqueue('weights',user.email));return;}
    if(p==='/api/equivalents/refresh'&&req.method==='POST'){permitted(user,['admin','manager']);const b=await body(req);const result=await equivalents.refresh(b.id);await audit(user,'erplain.live.equivalents_refreshed',{id:b.id,...result});json(res,200,result);return;}
    if(p==='/api/connection-modes'&&req.method==='GET'){const configured=async file=>{try{return Object.keys(JSON.parse(await readFile(path.join(directory,file),'utf8'))).length>0;}catch{return false;}};json(res,200,{shopify:await configured('shopify-readonly.json'),temu:!!temuService,carrierTest:!!partialConfig,carrierProduction:!!productionConfig});return;}
    if(await erplainRefresh.routes({p,url,req,res,user,body,json,permitted}))return;
    if(p==='/api/me'){json(res,200,user);return;}

    if(p==='/api/routing'&&req.method==='GET'){json(res,200,await loadRouting(db));return;}

    if(p==='/api/routing'&&req.method==='POST'){permitted(user,['admin','manager']);const c=validateRouting(await body(req));await db.query("INSERT INTO settings VALUES('routing',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify(c)]);await db.query("UPDATE jobs j SET status='pending',available_at=now() FROM orders o WHERE o.id=j.order_id AND o.channel='shopify' AND j.kind='label' AND j.status='blocked' AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)");await audit(user,'routing.saved',c);json(res,200,c);return;}

    if(p==='/api/stocks/sync'&&req.method==='POST'){permitted(user,['admin','manager']);json(res,202,await readerJobs.enqueue('stocks',user.email));return;}

    if(p==='/api/stocks'&&req.method==='GET'){

      const q='%'+(url.searchParams.get('search')||'').slice(0,100)+'%',page=Math.max(1,Number(url.searchParams.get('page'))||1);

      const rows=(await db.query('SELECT * FROM stock_cache WHERE sku ILIKE $1 OR label ILIKE $1 ORDER BY sku,variant_id LIMIT 100 OFFSET $2',[q,(page-1)*100])).rows;

      const total=Number((await db.query('SELECT count(*) n FROM stock_cache WHERE sku ILIKE $1 OR label ILIKE $1',[q])).rows[0].n);json(res,200,{rows,total,page,pages:Math.max(1,Math.ceil(total/100)),sync:await readerJobs.snapshot('stocks',()=>stocks.status())});return;

    }

    if(p==='/api/erplain/live/queue'&&req.method==='POST'){permitted(user,['admin','manager']);const b=await body(req);const queued=await queueErplainLive(db,b.ids);await audit(user,'erplain.live.queued',{queued});json(res,202,{queued});return;}

    if(p==='/api/erplain/live/jobs'&&req.method==='GET'){json(res,200,{rows:(await db.query('SELECT j.*,o.reference,o.erp_live FROM erp_live_jobs j JOIN orders o ON o.id=j.order_id ORDER BY j.updated_at DESC')).rows});return;}



    if(p==='/api/partial/preview'&&req.method==='GET'){permitted(user,operational);json(res,200,await partialWorker.snapshot(url.searchParams.get('id')));return;}
    if(p==='/api/erplain/stock/restore-cancelled'&&req.method==='POST'){permitted(user,operational);const b=await body(req);if(typeof b.id!=='string'||!/^\d+$/.test(String(b.stockId||'')))throw Error('Restitution de stock invalide');const result=await restoreCancelledDeliveryStock(db,erplainAccount(directory,'live'),b.id,b.stockId);await audit(user,'erplain.cancelled_stock_restored',{orderId:b.id,stockId:result.restoredStockId,replayed:result.replayed});json(res,200,{message:result.message,stockHolds:result.stockHolds});return;}
    if(p==='/api/erplain/documents/refresh'&&req.method==='POST'){permitted(user,operational);const b=await body(req);if(typeof b.id!=='string'||!['bc','bl'].includes(b.kind))throw Error('Actualisation BC/BL invalide');const result=await refreshErplainDocuments(db,erplainAccount(directory,'source'),b.id);await audit(user,'erplain.documents_refreshed',{orderId:b.id,kind:b.kind,notFound:!!result.notFound,stockHolds:result.stockHolds.length});json(res,200,{message:result.message,stockHolds:result.stockHolds,notFound:!!result.notFound});return;}
    if(p==='/api/partial/refresh'&&req.method==='POST'){permitted(user,operational);const b=await body(req);const result=await partialWorker.refresh(b.id);await audit(user,'partial.erplain_refreshed',{orderId:b.id,stockHolds:result.stockHolds.length});json(res,200,{message:result.message,stockHolds:result.stockHolds});return;}
    if(p==='/api/partial/prepare'&&req.method==='POST'){permitted(user,operational);const b=await body(req);const result=await partialWorker.prepare(b.id,b.selection,b.requestId,b.labelChoice??(b.replaceLabel===true?'replace':null));await audit(user,'partial.prepared',{orderId:b.id,deliveryId:result.id,replayed:result.replayed||false});json(res,202,result);return;}
    if(p==='/api/partial/retry'&&req.method==='POST'){permitted(user,operational);const b=await body(req);const rows=(await db.query("UPDATE partial_deliveries SET status=CASE WHEN carrier_result IS NOT NULL THEN 'awaiting_pdf' WHEN stage='finalizing_bl' THEN 'finalizing_bl' ELSE 'bl_ready' END,error=null WHERE id=$1 AND status='review' AND stock_document IS NOT NULL AND (carrier_result IS NOT NULL OR stage IN ('bl_ready','finalizing_bl')) RETURNING id",[b.id])).rows;if(!rows.length)throw new Error('Création incertaine : rapprochement requis, aucun nouvel envoi automatique');await audit(user,'partial.retry',{deliveryId:b.id});json(res,202,{ok:true});return;}
    if(p==='/api/partial/visible'&&req.method==='POST'){
      const {ids}=await body(req);if(!Array.isArray(ids)||ids.length>200||ids.some(id=>typeof id!=='string'))throw new Error('Page de commandes invalide');
      const rows=(await db.query("SELECT d.id,d.order_id,o.reference,o.channel,o.recipient,o.address,o.erp_live,d.status,d.selection,d.bl,d.carrier,d.weight_kg,d.parcel_count,d.tracking,d.error,d.stage,d.label_choice,d.environment,d.created_at,(SELECT count(*)::int FROM partial_documents p WHERE p.delivery_id=d.id) AS documents FROM partial_deliveries d JOIN orders o ON o.id=d.order_id WHERE d.order_id=ANY($1::text[]) ORDER BY d.created_at,d.id",[ids])).rows;json(res,200,{rows});return;
    }
    if(p==='/api/partial/list'&&req.method==='GET'){const rows=(await db.query("SELECT d.id,d.order_id,o.reference,d.status,d.selection,d.bl,d.carrier,d.weight_kg,d.parcel_count,d.tracking,d.error,d.stage,d.environment,d.created_at,(SELECT count(*)::int FROM partial_documents p WHERE p.delivery_id=d.id) AS documents FROM partial_deliveries d JOIN orders o ON o.id=d.order_id WHERE ($1='' OR d.order_id=$1) ORDER BY d.created_at DESC LIMIT 100",[url.searchParams.get('id')||''])).rows;json(res,200,{rows});return;}
    const partialDoc=p.match(/^\/api\/partial\/documents\/([^/]+)\/(\d+)$/);
    if(partialDoc&&req.method==='GET'){const row=(await db.query('SELECT pdf FROM partial_documents WHERE delivery_id=$1 AND document_index=$2',[partialDoc[1],Number(partialDoc[2])])).rows[0];if(!row)throw new Error('PDF partiel indisponible');res.setHeader('Content-Type','application/pdf');await labelAttachment(db,res,'partial',partialDoc[1],Number(partialDoc[2])+1);res.end(await currentPartialSkuPdf(db,row.pdf,partialDoc[1],Number(partialDoc[2])));return;}

    if(p==='/api/erplain/progress'&&req.method==='GET'){json(res,200,await erplainProgress(db,{status:()=>readerJobs.snapshot('catalog',()=>catalog.status())},{status:()=>readerJobs.snapshot('stocks',()=>stocks.status())}));return;}

    if(p==='/api/erplain/status'&&req.method==='GET'){

      const snapshot=JSON.parse(await readFile(path.join(directory,'live-reference-status.json'),'utf8'));
      json(res,200,{...await catalog.status(),liveAccount:{...snapshot.company,configured:true,workflowEnabled:process.env.ERPLAIN_LIVE_WRITES==='1'},importsEnabled:process.env.MIGRATION_PREPARATION!=='1',writesEnabled:process.env.ERPLAIN_LIVE_WRITES==='1',mode:process.env.MIGRATION_PREPARATION==='1'?'live-readonly-preparation':'live-active'});return;

    }

    if(p==='/api/erplain/config'&&req.method==='POST'){permitted(user,['admin']);const input=await body(req);await catalog.saveConfig(input);await audit(user,'erplain.readonly.configured');json(res,200,await readerJobs.enqueue('catalog',user.email));return;}

    if(p==='/api/erplain/sync'&&req.method==='POST'){permitted(user,['admin','manager']);await audit(user,'erplain.weights.read_requested');json(res,200,await catalog.start());return;}

    if(p==='/api/logout'&&req.method==='POST'){

      const token=req.headers.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('v3session='))?.slice(10);await db.query('DELETE FROM sessions WHERE token=$1',[tokenHash(token||'')]);res.setHeader('Set-Cookie','v3session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(res,200,{ok:true});return;

    }

    if(p==='/api/dashboard'&&req.method==='GET'){

      const {rows}=await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE label_status IN ('blocked','waiting_catalog'))::int AS blocked,count(*) FILTER(WHERE label_status IN ('sandbox_ready','production_ready'))::int AS labels,count(*) FILTER(WHERE tracking_status='delivered_simulated')::int AS delivered FROM orders WHERE archived=false`);

      const counts=(await db.query(`SELECT (SELECT count(*)::int FROM mappings) AS mappings,(SELECT count(*)::int FROM jobs WHERE status='pending') AS pending,(SELECT count(*)::int FROM partial_deliveries WHERE status='ready') AS partial_labels`)).rows[0];json(res,200,{...rows[0],...counts,labels:rows[0].labels});return;

    }

    if((p==='/api/orders'||p==='/api/order-problem-types')&&req.method==='GET'){
      const catalogOnly=p==='/api/order-problem-types';
      const problemLabels=url.searchParams.getAll('problem-label').filter(Boolean);
      if(problemLabels.length>100||problemLabels.some(label=>label.length>2000))throw Error('Sélection de problèmes invalide');
      const scanAll=catalogOnly||problemLabels.length>0;
      const scopeParams=new URLSearchParams(url.searchParams);scopeParams.delete('problem-label');
      const diagnosticStart=Date.now();

      const search=(url.searchParams.get('search')||'').slice(0,120),channel=url.searchParams.get('channel')||'',status=url.searchParams.get('status')||'';

      const page=Math.max(1,Math.min(10000,parseInt(url.searchParams.get('page')||'1')||1));

      const pageSize=[50,100,200].includes(Number(url.searchParams.get('pageSize')))?Number(url.searchParams.get('pageSize')):50;
      const {where,args,order}=orderQuery(scopeParams);

      let {rows}=await db.query(`WITH paged AS MATERIALIZED (SELECT id,(SELECT sum(CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id) AS item_quantity FROM orders ${where} ORDER BY ${order} ${scanAll?'':`LIMIT ${pageSize} OFFSET $${args.length+1}`} ) SELECT ${managerSql} AS account_manager,coalesce((SELECT CASE WHEN r.status='review' THEN r.error ELSE null END FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC,id DESC LIMIT 1),(SELECT state->>'result' FROM order_recheck_monitor WHERE order_id=orders.id AND state->>'blocked'='true')) AS resolution_error,(SELECT r.updated_at FROM resolution_jobs r WHERE r.order_id=orders.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS resolution_error_updated_at,resolution_pending_resume,(SELECT json_build_object('id',r.id,'stage',r.stage) FROM resolution_jobs r WHERE r.order_id=orders.id AND r.status IN ('queued','running','waiting') LIMIT 1) AS resolution_active,suspension,archived,CASE WHEN partial_mode THEN ${partialAllocationSql} ELSE '[]'::jsonb END AS partial_allocation,partial_mode,erp_live,id,channel,reference,recipient,address,source_payload,source_date,received_at,label_status,erp_status,tracking_status,invoice_status,weight_kg,parcel_count,carrier,issue,simulation,(SELECT json_agg(source_payload) FROM lines WHERE order_id=orders.id) AS price_sources,(SELECT json_agg(json_build_object('sku',CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN orders.channel IN ('tender','samples') THEN l.source_sku END) END,'quantity',CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,CASE WHEN orders.channel IN ('tender','samples') THEN l.quantity END) END,'source_sku',l.source_sku,'source_quantity',l.quantity,'mapping_exists',m.source_sku IS NOT NULL,'catalog_issue',CASE WHEN l.source_payload->>'erplainCorrectedWeightKg' IS NOT NULL THEN null ELSE c.message END) ORDER BY l.source_line) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku LEFT JOIN catalog_results c ON c.sku=CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN orders.channel IN ('tender','samples') THEN l.source_sku END) END WHERE l.order_id=orders.id) AS sku_lines,(SELECT sum(CASE WHEN (l.source_payload->>'mappingScope'='order' OR l.source_payload->>'origin'='erplain_live_equivalent') THEN l.target_quantity WHEN m.source_qty>0 THEN round(l.quantity*m.target_qty/m.source_qty,6) ELSE coalesce(l.target_quantity,l.quantity) END) FROM lines l LEFT JOIN mappings m ON m.channel=orders.channel AND m.source_sku=l.source_sku WHERE l.order_id=orders.id) AS item_quantity,(SELECT count(*) FROM lines WHERE order_id=orders.id) AS line_count,(SELECT json_build_object('status',status,'error',error,'environment',environment,'tracking',tracking,'stock_override',stock_override) FROM carrier_jobs WHERE order_id=orders.id) AS carrier_job,(SELECT json_build_object('status',status,'error',error,'updated_at',updated_at) FROM erp_live_jobs e WHERE e.order_id=orders.id) AS erp_live_job,(SELECT count(*)::int FROM carrier_documents d JOIN carrier_jobs c ON c.order_id=d.order_id WHERE d.order_id=orders.id AND c.status='ready') AS document_count FROM orders WHERE id IN (SELECT id FROM paged) ORDER BY ${order}`,scanAll?args:[...args,(page-1)*pageSize]);

      const diagnosticPage=Date.now();for(let offset=0;offset<rows.length;offset+=200)await orderPageDetails(db,rows.slice(offset,offset+200));const diagnosticDetails=Date.now();
      for(const row of rows)projectCurrentDiagnostics(row);
      


      for(const row of rows){

        const amounts=(row.price_sources||[]).map(l=>l.itemprice??l.totalht??l.totalttc);delete row.price_sources;

        row.currency=row.source_payload.currency||'';

        row.total_price=amounts.length&&amounts.every(v=>v!==undefined&&v!==''&&Number.isFinite(Number(String(v).replace(',','.'))))?Math.round(amounts.reduce((n,v)=>n+Number(String(v).replace(',','.')),0)*100)/100:null;

        row.gofo_zone_refusal=row.source_payload?.gofoZoneRefusal||null;
        row.source_payload={shopifyDeliveryMode:row.source_payload?.shopifyDeliveryMode,...(row.source_payload?.erplainImported===true&&row.source_payload?.account==='live'?{erplainImported:true,account:'live'}:{})};

      }

      const connection=await readerJobs.snapshot('catalog',()=>catalog.status());

      for(const row of rows)if(row.label_status==='waiting_catalog'&&connection.configured&&!connection.running&&!connection.nextRetryAt){row.label_status='weight_pending';row.issue='Poids Erplain non disponible dans V3 ; consulter Connexions pour le dernier résultat. Aucun téléchargement en cours.';}
      if(!connection.configured)for(const row of rows)if(row.label_status==='waiting_catalog'){row.issue='Connexion Erplain à configurer : aucun téléchargement de poids en cours.';row.label_status='connection_missing';}

      let matched=null;
      if(scanAll){
        const problemParams=new URLSearchParams(scopeParams);problemParams.append('status','__problems');
        const problemScope=orderQuery(problemParams);
        const problemIds=(await db.query('SELECT id FROM orders '+problemScope.where,problemScope.args)).rows.map(row=>row.id);
        matched=selectProblemOrders(rows,catalogOnly?[]:problemLabels,currentProblemClassifier(),problemIds);
        if(catalogOnly){json(res,200,{problemTypes:matched.problemTypes,at:new Date().toISOString()});return;}
      }
      const {transportStats,summary}=matched?await orderStatistics(db,scopeParams,matched.rows.map(row=>row.id)):await cachedOrderSummary(scopeParams);
      const total=summary.total;
      if(matched)rows=paginateProblemOrders(matched,page,pageSize).rows;
      json(res,200,{rows,transportStats,summary,total,page,pages:Math.max(1,Math.ceil(total/pageSize))});return;

    }

    if(p==='/api/products'&&req.method==='GET'){

      const search=(url.searchParams.get('search')||'').slice(0,100);

      const page=Math.max(1,parseInt(url.searchParams.get('page')||'1')||1);

      const pattern='%'+search.replace(/[%_\\]/g,'\\$&')+'%';

      const {rows}=await db.query('SELECT sku,weight_kg,origin,updated_at FROM products WHERE sku ILIKE $1 ORDER BY sku LIMIT 50 OFFSET $2',[pattern,(page-1)*50]);

      const total=Number((await db.query('SELECT count(*) AS n FROM products WHERE sku ILIKE $1',[pattern])).rows[0].n);

      json(res,200,{rows,total,page,pages:Math.max(1,Math.ceil(total/50)),sync:await readerJobs.snapshot('catalog',()=>catalog.status())});return;

    }

    if(p==='/api/mappings'&&req.method==='GET'){

      const search=(url.searchParams.get('search')||'').slice(0,100),page=Math.max(1,parseInt(url.searchParams.get('page')||'1')||1),pattern=search?'%'+search.replace(/[%_\\]/g,'\\$&')+'%':'';

      const where="WHERE channel NOT IN ('tender','samples') AND ($1='' OR source_sku ILIKE $1 OR target_sku ILIKE $1)";

      const {rows}=await db.query('SELECT * FROM mappings '+where+' ORDER BY channel,source_sku LIMIT 100 OFFSET $2',[pattern,(page-1)*100]);

      const total=Number((await db.query('SELECT count(*) AS n FROM mappings '+where,[pattern])).rows[0].n);json(res,200,{rows,total,page,pages:Math.max(1,Math.ceil(total/100))});return;

    }

    if(await temuExcelImportRoutes({p,req,res,user,body,json,permitted,db}))return;

    if(p==='/api/orders/processing'&&req.method==='POST'){const b=await body(req);const rows=await processingRows(db,b.ids);const monitors=new Map((await db.query('SELECT order_id,state FROM order_recheck_monitor WHERE order_id=ANY($1::text[])',[b.ids])).rows.map(m=>[m.order_id,m.state]));for(const row of rows)row.monitoring=monitors.get(row.id)||null;json(res,200,{rows,at:new Date().toISOString()});return;}
    if(p==='/api/orders/priority'&&req.method==='POST'){const b=await body(req);json(res,200,await setOrderPriority(db,b,user));return;}
    if(p==='/api/import-corrections/context'&&req.method==='GET'){permitted(user,operational);json(res,200,await importCorrectionService.context(url.searchParams.get('id')));return;}
    if(p==='/api/import-corrections/preview'&&req.method==='POST'){permitted(user,operational);json(res,200,await importCorrectionService.preview(await body(req)));return;}
    if(p==='/api/import-corrections/apply'&&req.method==='POST'){permitted(user,operational);const b=await body(req);const r=await importCorrectionService.apply(b,user);await audit(user,'import.correction.'+r.action,{orderId:r.id,requestId:b.requestId,replayed:!!r.replayed});json(res,200,r);return;}
    if(p==='/api/import/authorize'&&req.method==='POST'){permitted(user,operational);json(res,200,await importApprovals.authorize(user,await body(req)));return;}
    if(p==='/api/import'&&req.method==='POST'){

      const b=await body(req);permitted(user,b.kind==='mapping'?['admin','manager']:operational);

      if(typeof b.content!=='string'||typeof b.filename!=='string')throw new Error('Fichier absent');

      if(b.kind!=='mapping')importApprovals.assert(user,b);
      const data=Buffer.from(b.content,'base64');const result=b.kind==='mapping'?await importMapping(db,data,b.filename):await importOrders(db,data,b.filename,b.kind,b.selection,{duplicateSelection:b.duplicateSelection,requestId:b.requestId,shopifyReader:async()=>shopifyCollector(await loadShopifyConfig(directory))});

      await audit(user,'import',{kind:b.kind,rows:result.rows,created:result.created,skipped:result.skipped,copies:result.copies||0,replayed:result.replayed||false,errors:result.errors.length});readerJobs.enqueue('catalog',user.email).catch(()=>{});json(res,200,result);return;

    }

    if(p==='/api/demo'){json(res,410,{error:'Création fictive retirée. Utiliser un import ou une API.'});return;}

    if(p==='/api/tracking'&&req.method==='POST'){

      permitted(user,operational);const b=await body(req);if(!Array.isArray(b.ids)||b.ids.some(id=>typeof id!=='string'))throw new Error('Sélection invalide');

      if(b.delivered)permitted(user,['admin','manager']);const result=await refreshTracking(db,b.ids,!!b.delivered);await audit(user,b.delivered?'delivery.simulated':'tracking.local',{count:result.updated});json(res,200,result);return;

    }

    if(p.startsWith('/api/labels/')&&req.method==='GET'){

      const id=p.slice('/api/labels/'.length);const {rows}=await db.query('SELECT pdf FROM labels WHERE order_id=$1',[id]);if(!rows.length){json(res,404,{error:'Document indisponible'});return;}

      res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="SIMULATION.pdf"');res.end(Buffer.from(rows[0].pdf));return;

    }

    if(p==='/api/users'&&req.method==='GET'){permitted(user,['admin']);json(res,200,{rows:(await db.query('SELECT email,role,permissions,created_at FROM users ORDER BY email')).rows});return;}

    if(p==='/api/users'&&req.method==='POST'){permitted(user,['admin']);const b=await body(req);if(!ROLES.includes(b.role))throw new Error('Rôle invalide');const result=await createUser(db,b.email,b.password,b.role);await audit(user,'user.created',{email:b.email,role:b.role});json(res,201,result);return;}

    if(p==='/api/audit'&&req.method==='GET'){permitted(user,['admin','manager']);json(res,200,{rows:(await db.query('SELECT user_email,action,detail,created_at FROM audit ORDER BY id DESC LIMIT 100')).rows});return;}

    json(res,404,{error:'Route inexistante'});

  }catch(e){const safe=e.code==='23505'?'Cet élément existe déjà.':e.message;json(res,e.status||400,{error:safe});}finally{activeRequests--;}

});

server.requestTimeout=30000;server.headersTimeout=70000;server.keepAliveTimeout=65000;

if(config.http)server.listen(port,host,()=>console.log(`NEXTECH LOGISTIC V3 : ${origin} (ERPLAIN LIVE : préparation en lecture seule, aucun import)`));

async function shutdown(){if(shuttingDown)return;shuttingDown=true;try{
 await events.stop();
 const httpClosed=config.http?new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();}):Promise.resolve();
 runtime.beginStop();catalog.stop();await runtime.stop();
 await Promise.all([catalog.wait(),allWeights.wait(),stocks.wait()]);
 while(equivalenceImports.running||stockResume.running||v2Followup.running||erplainRefresh.running||resolutions.running||corrections.running||partialWorker.running||erpWorker.running||carrierWorkers?.active.size||tracking.running||lifecycle.running||temuLocal.running)await new Promise(r=>setTimeout(r,100));
 while(activeRequests)await new Promise(r=>setTimeout(r,100));server.closeAllConnections();
 await httpClosed;await releaseLeader();await db.close();process.exit(0);
 }catch{console.error('Arrêt incomplet : contrôle des traitements nécessaire');process.exit(1);}}

process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);






