import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const sourceRoot=process.env.SUSPENSION_SOURCE_ROOT||path.resolve('src');
const source=name=>import(pathToFileURL(path.join(sourceRoot,name)).href);
const {initializeOrderSuspension,orderSuspensionService,validateSuspension,suspensionBlock}=await source('order-suspension.mjs');
const {cancellationBlock}=await source('erp-transient-policy.mjs');
const {PGlite}=await (process.env.PGLITE_MODULE?import(pathToFileURL(process.env.PGLITE_MODULE).href):import('@electric-sql/pglite'));
const pg=new PGlite();await pg.waitReady;
const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)});
const db=wrap(pg);db.transaction=fn=>pg.transaction(tx=>fn(wrap(tx)));
await db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,reference TEXT,archived BOOLEAN DEFAULT false,tracking_status TEXT DEFAULT 'not_shipped',label_status TEXT DEFAULT 'blocked',erp_live JSONB DEFAULT '{}',source_payload JSONB DEFAULT '{}',resolution_pending_resume BOOLEAN DEFAULT false);
CREATE TABLE audit(id SERIAL,user_email TEXT,action TEXT,detail JSONB);
CREATE TABLE erp_live_jobs(order_id TEXT,status TEXT,error TEXT,updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE carrier_jobs(order_id TEXT,status TEXT,error TEXT,result JSONB,updated_at TIMESTAMPTZ DEFAULT now(),environment TEXT);
CREATE TABLE resolution_jobs(id TEXT,order_id TEXT,status TEXT,stage TEXT,error TEXT,updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE correction_jobs(id TEXT,order_id TEXT,status TEXT,error TEXT,updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE partial_deliveries(id TEXT,order_id TEXT,status TEXT,error TEXT,stock_document JSONB);
CREATE TABLE extra_parcels(id TEXT,order_id TEXT,status TEXT,error TEXT,result JSONB);
CREATE TABLE jobs(id TEXT,order_id TEXT,status TEXT,error TEXT);
CREATE TABLE temu_label_jobs(reference TEXT,status TEXT);
CREATE TABLE document_lifecycle(order_id TEXT,locked BOOLEAN);`);
await db.exec(`ALTER TABLE orders ADD COLUMN issue TEXT,ADD COLUMN channel TEXT DEFAULT 'temu',ADD COLUMN partial_mode BOOLEAN DEFAULT false,ADD COLUMN carrier TEXT,ADD COLUMN transport_choice TEXT,ADD COLUMN erp_status TEXT,ADD COLUMN recipient TEXT DEFAULT 'Fictif';
ALTER TABLE resolution_jobs ADD COLUMN action TEXT,ADD COLUMN payload JSONB DEFAULT '{}',ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE partial_deliveries ADD COLUMN selection JSONB DEFAULT '[]',ADD COLUMN bl JSONB DEFAULT '{}';
ALTER TABLE temu_label_jobs ADD COLUMN error TEXT;
CREATE TABLE lines(order_id TEXT,source_sku TEXT,target_sku TEXT,quantity NUMERIC,target_quantity NUMERIC,source_payload JSONB DEFAULT '{}');
CREATE TABLE mappings(channel TEXT,source_sku TEXT,target_sku TEXT,source_qty NUMERIC,target_qty NUMERIC);
CREATE TABLE catalog_results(sku TEXT,message TEXT);`);
await initializeOrderSuspension(db);await initializeOrderSuspension(db);
const user={role:'operator',email:'operator@example.test'};let bcStatus='active',bcMutationCount=0,failAfterMutation=false,billingCount=0,bls=[];
const api={async verify(){return {id:100174};},async request(query,args){
 if(query.includes('V3SuspensionBilling'))return {Order:{id:'123',external_reference:'PO-000-000',invoices_count:billingCount,paid_amount:0}};
 if(query.includes('V3DocumentRead'))return {Order:{id:'123',label:'TEST-BC',status:bcStatus,shipping_orders:{data:bls,paginatorInfo:{hasMorePages:false}}}};
 if(query.includes('V3SuspensionBLGuard('))return {ShippingOrder:{...bls.find(b=>b.id===String(args.id)),invoices_count:0,invoices:{data:[],paginatorInfo:{hasMorePages:false}},orders:{data:[{id:'123',status:bcStatus}],paginatorInfo:{hasMorePages:false}}}};
 if(query.includes('LifecycleBLStatus')){bls.find(b=>b.id===String(args.ids[0])).status=args.status;return {UpdateShippingOrdersStatus:true};}
 if(query.includes('LifecycleCancelOrder')){bcStatus='cancelled';bcMutationCount++;if(failAfterMutation){failAfterMutation=false;throw Error('Connexion interrompue');}return {UpdateOrder:{id:'123',status:bcStatus}};}
 throw Error('Unexpected mock API: '+query);
}};
const service=orderSuspensionService(db,api);
async function fresh(id='one'){return (await service.context(id)).order.suspension;}
async function change(action,id='one',note='Livraison impossible. Attente de la demande du client.'){
 return service[action]({id,note,expectedVersion:(await fresh(id)).version||''},user);
}
let checks=0;
async function check(name,fn){await fn();checks++;console.log('PASS '+name);}
await db.query('INSERT INTO orders(id,reference,erp_live) VALUES($1,$2,$3)',['one','PO-000-000',JSON.stringify({bc:{id:'123',label:'TEST-BC',status:'active'}})]);
await db.query("INSERT INTO orders(id,reference) VALUES('control','PO-000-CONTROL')");
await check('note obligatoire, longueur et version validées',async()=>{for(const note of ['', ' ', 'x'.repeat(2001)])assert.throws(()=>validateSuspension({id:'one',note,expectedVersion:''}));assert.throws(()=>validateSuspension({id:'one',note:'note'}));});
await check('droits serveur requis',async()=>{await assert.rejects(()=>service.suspend({id:'one',note:'note',expectedVersion:''},{role:'viewer'}),/Droits/);});
await db.exec("INSERT INTO erp_live_jobs(order_id,status) VALUES('one','pending');INSERT INTO resolution_jobs(id,order_id,status) VALUES('r1','one','queued');INSERT INTO jobs(id,order_id,status) VALUES('j1','one','pending');INSERT INTO correction_jobs(id,order_id,status) VALUES('c1','one','queued')");
await check('suspension persistante, audit et arrêt des travaux en file',async()=>{await change('suspend');const s=await fresh();assert.equal(s.active,true);assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='one'")).rows[0].status,'review');assert.equal((await db.query("SELECT status FROM resolution_jobs WHERE order_id='one'")).rows[0].status,'review');assert.equal((await db.query("SELECT status FROM jobs WHERE order_id='one'")).rows[0].status,'blocked');assert.equal((await db.query("SELECT status FROM correction_jobs WHERE order_id='one'")).rows[0].status,'review');assert.equal(bcMutationCount,0);assert.match(cancellationBlock((await service.context('one')).order),/suspendue/);});
await check('double clic/version périmée refusés',async()=>{await assert.rejects(()=>service.reactivate({id:'one',note:'Solution trouvée',expectedVersion:''},user),/changé/);assert.equal((await fresh()).active,true);});
await check('garde SQL de tous les traitements',async()=>{for(const [table,status] of [['erp_live_jobs','processing'],['resolution_jobs','running'],['correction_jobs','applying'],['jobs','processing']])await assert.rejects(()=>db.query(`UPDATE ${table} SET status=$1 WHERE order_id='one'`,[status]),/traitement interdit/);await assert.rejects(()=>db.query("INSERT INTO temu_label_jobs(reference,status) VALUES('PO-000-000','purchasing')"),/traitement interdit/);await assert.rejects(()=>db.query("INSERT INTO document_lifecycle(order_id,locked) VALUES('one',true)"),/traitement interdit/);});
await check('réactivation conserve l’historique et ne démarre aucun travail',async()=>{await change('reactivate','one','Une solution est disponible.');assert.equal((await fresh()).active,false);assert.equal((await db.query("SELECT resolution_pending_resume FROM orders WHERE id='one'")).rows[0].resolution_pending_resume,true);assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='one'")).rows[0].status,'review');assert.equal((await service.context('one')).history.length,2);assert.equal(bcMutationCount,0);});
await check('réactivation d’une commande jamais suspendue refusée',async()=>{await assert.rejects(()=>change('reactivate','control'),/déjà active/);});
await check('traitement actif interdit la suspension',async()=>{await db.query("UPDATE erp_live_jobs SET status='processing' WHERE order_id='one'");await assert.rejects(()=>change('suspend'),/traitement en cours/);assert.equal((await fresh()).active,false);await db.query("UPDATE erp_live_jobs SET status='review' WHERE order_id='one'");});
await check('suspension locale expédiée/livrée : documents conservés, annulation interdite, réactivation sans reprise',async()=>{
 const initial=(await service.context('one')).order;
 const {activeProblemOrderSql}=await source('order-query.mjs');
 for(const scenario of [{tracking:'shipped'},{tracking:'delivered'},{tracking:'in_transit'},{tracking:'delivered_simulated'},{tracking:'not_shipped',bl:'shipped'},{tracking:'not_shipped',bl:'delivered'}]){
  const erp={...initial.erp_live,...(scenario.bl?{bl:{id:'456',status:scenario.bl}}:{})};
  await db.query('UPDATE orders SET tracking_status=$2,erp_live=$3 WHERE id=$1',['one',scenario.tracking,JSON.stringify(erp)]);
  const before=bcMutationCount;await change('suspend','one','Commande livrée : retirer des problèmes actifs.');
  const suspended=(await service.context('one')).order;assert.equal(suspended.suspension.active,true);assert.equal(suspended.tracking_status,scenario.tracking);assert.deepEqual(suspended.erp_live,erp);
  assert.equal((await db.query('SELECT id FROM orders WHERE id=$1 AND '+activeProblemOrderSql,['one'])).rows.length,0);
  await assert.rejects(()=>service.cancelErplain({id:'one',expectedVersion:(suspended.suspension.version),confirm:true},user),/annulation ERPLAIN impossible/);assert.equal(bcMutationCount,before);
  await change('reactivate','one','Réafficher dans V3 sans reprise.');assert.equal((await service.context('one')).order.tracking_status,scenario.tracking);assert.deepEqual((await service.context('one')).order.erp_live,erp);
 }
 await db.query('UPDATE orders SET tracking_status=$2,erp_live=$3 WHERE id=$1',['one',initial.tracking_status,JSON.stringify(initial.erp_live)]);
});
await change('suspend');
const cancel=async()=>service.cancelErplain({id:'one',expectedVersion:(await fresh()).version,confirm:true},user);
await check('annulation ERP exige confirmation',async()=>{await assert.rejects(async()=>service.cancelErplain({id:'one',expectedVersion:(await fresh()).version},user),/Confirmer/);assert.equal(bcMutationCount,0);});
await check('BC facturé refusé sans mutation',async()=>{billingCount=1;await assert.rejects(cancel,/facturé/);billingCount=0;assert.equal(bcMutationCount,0);});
await check('BL expédié refusé sans mutation',async()=>{bls=[{id:'456',status:'shipped',update_stock:false}];await assert.rejects(cancel,/BL expédié/);bls=[];assert.equal(bcMutationCount,0);});
await check('mouvement de stock à rapprocher refusé',async()=>{await db.query("UPDATE orders SET erp_live=erp_live||'{\"stockDocument\":{\"id\":\"789\"}}'::jsonb WHERE id='one'");await assert.rejects(cancel,/Mouvement de stock/);await db.query("UPDATE orders SET erp_live=erp_live-'stockDocument' WHERE id='one'");});
await check('résultat externe incertain conservé, réactivation interdite',async()=>{failAfterMutation=true;await assert.rejects(cancel,/à vérifier/);assert.equal((await fresh()).erplainCancellation.status,'review');assert.equal(bcMutationCount,1);await assert.rejects(()=>change('reactivate'),/rapprocher/);});
await check('rapprochement relit ERP sans répéter l’annulation confirmée',async()=>{await cancel();assert.equal(bcMutationCount,1);assert.equal((await fresh()).erplainCancellation.status,'complete');assert.equal((await fresh()).active,true);assert.equal((await service.context('one')).order.tracking_status,'not_shipped');});
await check('réactivation après annulation ERP garde la protection contre recréation',async()=>{await change('reactivate','one','Client à recontacter, aucun nouveau BC autorisé.');const o=(await service.context('one')).order;assert.equal(o.suspension.active,false);assert.match(suspensionBlock(o),/recréation/);await assert.rejects(()=>db.query("UPDATE erp_live_jobs SET status='processing' WHERE order_id='one'"),/traitement interdit/);});
await check('vérification seule après réponse incertaine sans nouvelle mutation',async()=>{await change('suspend');await db.query("UPDATE orders SET suspension=suspension || $1::jsonb WHERE id='one'",[JSON.stringify({erplainCancellation:{status:'review',bcId:'123'}})]);bcStatus='active';const before=bcMutationCount;await service.cancelErplain({id:'one',expectedVersion:(await fresh()).version,verifyOnly:true},user);assert.equal(bcMutationCount,before);assert.equal((await fresh()).erplainCancellation.status,'review');await service.cancelErplain({id:'one',expectedVersion:(await fresh()).version,confirm:true},user);assert.equal(bcMutationCount,before);});
await pg.close();console.log(JSON.stringify({checks,passed:checks,failed:0,businessCalls:'MOCK ONLY'}));
