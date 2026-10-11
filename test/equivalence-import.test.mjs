import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {parseEquivalenceFile,allocateImportStock,importHeaders} from '../src/equivalence-import-file.mjs';
import {equivalenceImportService,initializeEquivalenceImports} from '../src/equivalence-import.mjs';
import {finishSubstitutionAttempt} from '../src/substitution-attempt.mjs';

async function workbook(rows,headers=importHeaders,name='Onglet type'){
 const w=new ExcelJS.Workbook(),s=w.addWorksheet(name);s.addRow(headers);for(const r of rows)s.addRow(r);return Buffer.from(await w.xlsx.writeBuffer()).toString('base64');
}
test('les quatre colonnes du modèle conservent les SKU texte',async()=>{
 const data=await parseEquivalenceFile(await workbook([['#EXEMPLE','BASE-001','0004425',100]]));assert.deepEqual(data[0],{line:2,reference:'#EXEMPLE',sku:'BASE-001',replacementSku:'0004425',replacementQuantity:100});
});
test('titres insensibles aux accents et colonnes réordonnées, décimale française',async()=>{
 const data=await parseEquivalenceFile(await workbook([['00041','1,5','#001','00012']],['SKU de remplacement','Qte de remplacement','Numero de commande','SKU de base']));assert.equal(data[0].sku,'00012');assert.equal(data[0].replacementQuantity,1.5);
});
test('aucune formule, aucun lien ni mauvais onglet accepté',async()=>{
 await assert.rejects(parseEquivalenceFile(await workbook([['#1',{formula:'1+1',result:2},'B',1]])),/Formules/);
 await assert.rejects(parseEquivalenceFile(await workbook([['#1','A',{text:'B',hyperlink:'https://example.org'},1]])),/liens/);
 await assert.rejects(parseEquivalenceFile(await workbook([],importHeaders,'Propositions')),/absent/);
 await assert.rejects(parseEquivalenceFile('AAAA'),/XLSX/);
});
test('doublons bloquent toutes les occurrences ; quantité invalide et SKU identiques bloqués',async()=>{
 const rows=await parseEquivalenceFile(await workbook([['#1','A','B',1],['#1','A','C',2],['#2','A','A',1],['#3','A','B',-1]]));assert(rows.every(r=>r.error));
});
test('limites et colonnes dupliquées refusées',async()=>{
 await assert.rejects(parseEquivalenceFile(await workbook([],importHeaders.concat(importHeaders[0]))),/répétée/);
 await assert.rejects(parseEquivalenceFile(await workbook(Array.from({length:1001},(_,i)=>['#'+i,'A','B',1]))),/1 000/);
});
const plan=(orderId,quantity=6,available=10,location='1')=>({line:Number(orderId),orderId,sku:'A',replacementQuantity:quantity,plan:{available,items:[{variant:{id:'2'},location:{id:location}}],commercialBefore:{line_items:[]}}});
test('stock partagé : couvre chaque ligne séparément mais pas le fichier entier',()=>{
 const rows=[plan('1'),plan('2')];assert.equal(allocateImportStock(rows).size,2);assert.equal(allocateImportStock(rows,[1]).size,0);assert.equal(allocateImportStock([plan('1',6,10,'1'),plan('2',6,10,'2')]).size,0);
});
test('stock déjà nécessaire dans le même BC compté une seule fois',()=>{
 const rows=[plan('1',2),{...plan('1',2),line:2}];for(const r of rows)r.plan.commercialBefore.line_items=[{type:'normal',quantity:7,variant:{id:'2'},location:{id:'1'}}];assert.equal(allocateImportStock(rows).size,2);
 rows[0].plan.available=12;rows[1].plan.available=12;assert.equal(allocateImportStock(rows).size,0);
});
async function fixture(){
 const pg=new PGlite();await pg.waitReady;
 await pg.exec(`CREATE TABLE orders(id text primary key,reference text,channel text,address jsonb,erp_live jsonb,suspension jsonb,archived boolean default false,issue text,resolution_pending_resume boolean default false);
 CREATE TABLE resolution_jobs(id text primary key,order_id text references orders(id),request_id text unique,action text,payload jsonb,status text default 'queued',stage text default 'En attente',error text,result jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 CREATE UNIQUE INDEX resolution_busy ON resolution_jobs(order_id) WHERE status IN ('queued','running','waiting');
 CREATE TABLE lines(id text,order_id text,target_sku text,source_sku text);
 CREATE TABLE audit(user_email text,action text,detail jsonb);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);`);
 const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)}),db={...wrap(pg),transaction:f=>pg.transaction(tx=>f(wrap(tx))),recoverInterrupted:false};
 await initializeEquivalenceImports(db);
 const bcs=new Map(),make=(id,sku,qty)=>({id,type:'normal',quantity:qty,variant:{id:sku,sku},location:{id:'1'}});
 async function order(id,reference,channel='shopify'){
  await db.query('INSERT INTO orders(id,reference,channel,address,erp_live,suspension) VALUES($1,$2,$3,\'{"country":"FR"}\',$4,\'{}\')',[id,reference,channel,JSON.stringify({bc:{id}})]);
  bcs.set(id,{id,line_items:[make('1','A',20),make('2','C',10)]});await db.query('INSERT INTO lines VALUES($1,$2,\'A\',\'A\')',[id+'l',id]);
 }
 await order('o1','#1');await order('o2','#2');await order('ao','AO-1','tender');
 const api={verify:async()=>{},request:async(q,{id})=>({Order:bcs.get(id)})};
 const preview=async(db,api,o,p)=>{
  const bc=bcs.get(o.id),original=bc.line_items.find(l=>l.variant.sku===p.sku);if(!original)throw Error('SKU absent');
  return {available:100,weightKg:1,items:[{variant:{id:p.replacementSku},location:{id:'1'}}],commercialBefore:structuredClone(bc),replaceQuantity:Number(original.quantity),previewFingerprint:createHash('sha256').update(JSON.stringify({bc,p:{sku:p.sku,replacementSku:p.replacementSku,quantity:p.replacementQuantity}})).digest('hex')};
 };
 const service=equivalenceImportService(db,'',{api,preview});
 async function call(path,data,user={email:'admin@test',role:'admin'}){let result;await service.routes({p:path,url:new URL('https://example.org'+path),req:{method:'POST'},res:{},user,body:async()=>data,json:(res,status,value)=>{result={status,...value};},permitted:(u,roles)=>{if(!roles.includes(u.role))throw Error('Droits insuffisants');}});return result;}
 async function analyze(input){const result=await call('/api/equivalence-import/analyze',{file:await workbook(input)});for(let i=0;i<input.length+1;i++)await service.run();return service.read(result.id);}
 async function complete(batch,line,{error=null,deferred=false}={}){
  const r=(await db.query('SELECT * FROM equivalence_import_rows WHERE batch_id=$1 AND line=$2',[batch,line])).rows[0];
  if(!error){const bc=bcs.get(r.order_id);bc.line_items=bc.line_items.filter(l=>l.variant.sku!==r.data.sku);bc.line_items.push(make('new',r.data.replacementSku,r.data.replacementQuantity));await db.query('DELETE FROM lines WHERE order_id=$1',[r.order_id]);for(const l of bc.line_items)await db.query('INSERT INTO lines VALUES($1,$2,$3,$3)',[r.order_id+l.variant.sku,r.order_id,l.variant.sku]);await db.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[r.order_id,JSON.stringify({bc:{id:r.order_id},equivalentAttemptId:r.request_id})]);}
  await db.query('UPDATE resolution_jobs SET status=$2,error=$3,result=$4 WHERE id=$1',[r.job_id,error?'review':'complete',error,JSON.stringify({importDeferred:deferred})]);
 }
 return {db,pg,service,call,analyze,complete,bcs};
}
async function use(fn){const x=await fixture();try{await fn(x);}finally{await x.pg.close();}}
test('analyse ne crée aucun remplacement ; AO exclus ; décoche conservée',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20],['AO-1','A','B',1],['#2','A','B',20]]);assert.equal(b.status,'ready');assert.deepEqual(b.rows.map(r=>r.status),['valid','blocked','valid']);assert.equal((await x.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
 await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});await x.service.run();const result=await x.service.read(b.id);assert.deepEqual(result.rows.map(r=>r.status),['processing','blocked','skipped']);
}));
test('double clic même sélection ne crée pas de nouvelle demande ; sélection différente refusée',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20],['#2','A','B',20]]);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});await x.service.run();await x.service.run();assert.equal((await x.db.query("SELECT * FROM resolution_jobs WHERE action='replace-equivalent'")).rows.length,1);await assert.rejects(x.call('/api/equivalence-import/apply',{id:b.id,lines:[3]}),/autre sélection/);
}));
test('plusieurs lignes de la commande se succèdent sans rejouer la première',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20],['#1','C','D',10]]);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2,3]});await x.service.run();assert.deepEqual((await x.service.read(b.id)).rows.map(r=>r.status),['processing','queued']);await x.complete(b.id,2,{deferred:true});await x.service.run();assert.deepEqual((await x.service.read(b.id)).rows.map(r=>r.status),['applied','processing']);await x.complete(b.id,3);await x.service.run();assert.equal((await x.service.read(b.id)).status,'complete');assert.equal((await x.db.query("SELECT * FROM resolution_jobs WHERE action='replace-equivalent'")).rows.length,2);
}));
test('échec incertain bloque les autres lignes de la même commande mais pas les autres commandes',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20],['#1','C','D',10],['#2','A','B',20]]);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2,3,4]});await x.service.run();await x.complete(b.id,2,{error:'Résultat Erplain incertain'});await x.service.run();assert.deepEqual((await x.service.read(b.id)).rows.map(r=>r.status),['blocked','blocked','processing']);
}));
test('commande modifiée après l’aperçu : aucune demande de remplacement',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20]]);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});x.bcs.get('o1').line_items[0].quantity=19;await x.service.run();assert.equal((await x.service.read(b.id)).rows[0].status,'blocked');assert.equal((await x.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
}));
test('droits de consultation et opérateur ne permettent pas l’import métier',()=>use(async x=>{
 for(const role of ['viewer','operator'])await assert.rejects(x.call('/api/equivalence-import/analyze',{file:await workbook([['#1','A','B',1]])},{email:'u',role}),/Droits/);
}));
test('journal différé termine uniquement le remplacement et conserve l’attente des autres lignes',()=>use(async x=>{
 await x.db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,status) VALUES('j','o1','r','replace-equivalent','{}','running')");await finishSubstitutionAttempt(x.db,'o1','r',{}, {importDeferred:true});assert.equal((await x.db.query("SELECT status FROM resolution_jobs WHERE id='j'")).rows[0].status,'complete');
}));
test('réimport du même fichier après remplacement : déjà appliqué et aucune nouvelle mutation',()=>use(async x=>{
 const input=[['#1','A','B',20]],b=await x.analyze(input);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});await x.service.run();await x.complete(b.id,2);await x.service.run();const replay=await x.analyze(input);assert.equal(replay.rows[0].status,'already');assert.equal((await x.db.query("SELECT * FROM resolution_jobs WHERE action='replace-equivalent'")).rows.length,1);
}));
test('réservation du stock entre imports et commande déjà sélectionnée dans un autre import',()=>use(async x=>{
 const a=await x.analyze([['#1','A','B',60]]),b=await x.analyze([['#2','A','B',60]]),c=await x.analyze([['#1','C','D',10]]);
 await x.call('/api/equivalence-import/apply',{id:a.id,lines:[2]});await assert.rejects(x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]}),/Stock cumulé/);await assert.rejects(x.call('/api/equivalence-import/apply',{id:c.id,lines:[2]}),/import en cours/);
}));
test('une interruption vérifiée ne rejoue pas le remplacement',()=>use(async x=>{
 const b=await x.analyze([['#1','A','B',20]]);await x.call('/api/equivalence-import/apply',{id:b.id,lines:[2]});await x.service.run();await x.complete(b.id,2,{error:'Intervention interrompue : résultat à rapprocher'});await x.service.run();await x.service.run();assert.equal((await x.service.read(b.id)).rows[0].status,'blocked');assert.equal((await x.db.query("SELECT * FROM resolution_jobs WHERE action='replace-equivalent'")).rows.length,1);
}));
