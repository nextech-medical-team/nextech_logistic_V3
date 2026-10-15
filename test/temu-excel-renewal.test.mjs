import test from 'node:test';
import assert from 'node:assert/strict';
import {createTemuExcelTestDatabase} from './support/temu-excel-db.mjs';
import {temuExcelPreparation} from '../src/temu-excel-preparation.mjs';
import {excelRenewalCandidate} from '../src/temu-excel-renewal.mjs';
const reference='PO-141-FIXTURE',error='Excel : prix ou articles modifiés depuis la validation',user={role:'manager',email:'fixture@example.invalid'};
const candidate={channel:'temu',tracking_status:'not_shipped',source_payload:{origin:'temu_excel',temuExcelPreparation:{fingerprint:'old',jobId:'old-job'}},erp_live:{},suspension:{active:false}};
async function fixture(t){
 const db=await createTemuExcelTestDatabase();t.after(()=>db.close());
 await db.exec(`ALTER TABLE orders ADD COLUMN erp_live jsonb DEFAULT '{}',ADD COLUMN partial_mode boolean DEFAULT false,ADD COLUMN transport_choice text;
 ALTER TABLE lines ADD COLUMN target_sku text,ADD COLUMN target_quantity numeric;
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz DEFAULT now());
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,payload jsonb,result jsonb,status text DEFAULT 'queued',stage text DEFAULT 'En attente',error text,created_at timestamptz DEFAULT now());
 CREATE TABLE correction_jobs(order_id text,status text);
 CREATE TABLE temu_label_jobs(reference text,attempt_id text,packages jsonb DEFAULT '[]');
 CREATE TABLE temu_label_documents(reference text);
 CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE carrier_label_history(order_id text);CREATE TABLE partial_deliveries(order_id text);CREATE TABLE extra_parcels(order_id text);
 CREATE TABLE erplain_product_creation_attempts(sku text);`);
 const commercial={source:'temu_excel',fingerprint:'old',currency:'EUR',net:3.55,tax:.75,total:4.30};
 await db.query("INSERT INTO orders(id,channel,reference,recipient,address,source_payload,suspension,tracking_status,erp_live,resolution_pending_resume) VALUES('o','temu',$1,'Fixture',$2,$3,$4,'not_shipped','{}',true)",[reference,JSON.stringify({country:'NL',street:'Fixture',city:'Fixture',postal:'1234 AB'}),JSON.stringify({...candidate.source_payload,temuExcelCommercial:commercial}),JSON.stringify(candidate.suspension)]);
 const excel={'Total du prix de base après réduction':'€5,44','Taxe sur les produits':'€0,23',"Total de l'expédition (hors taxes)":'€2,47',"Taxe d'expédition":'€0,52','Total du prix de vente après réductions (hors taxes)':'€1,08'};
 await db.query("INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload,target_sku,target_quantity) VALUES('l','o','item','6963_P1',1,$1,'6963',1)",[JSON.stringify({excel})]);
 await db.query("INSERT INTO erp_live_jobs VALUES('o','review',$1,now())",[error]);
 await db.query("INSERT INTO resolution_jobs(id,order_id,action,status,error) VALUES('old-job','o','resume','review',$1)",[error]);
 const service=temuExcelPreparation(db),read=async()=>(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];
 return {db,service,read,async preview(){return service.preview(reference,{renew:true});},async input(){const p=await this.preview();return {reference,fingerprint:p.fingerprint,confirmPreparation:true,confirmRenewal:true};}};
}
test('renewal retains raw Excel and old validation, uses seller proceeds, and queues only one existing order',async t=>{
 const f=await fixture(t),old=await f.read(),lines=(await f.db.query('SELECT * FROM lines')).rows,p=await f.preview();
 assert.equal(p.previousCommercial.total,4.30);assert.equal(p.commercial.total,8.66);assert.equal(p.commercial.net,7.91);assert.equal(p.renewal,true);
 assert.deepEqual(await f.read(),old);const input=await f.input(),result=await f.service.prepare(input,user),o=await f.read();
 assert.equal(o.source_payload.temuExcelCommercial.total,8.66);assert.deepEqual(o.source_payload.temuExcelValidationHistory[0].commercial,old.source_payload.temuExcelCommercial);
 assert.deepEqual((await f.db.query('SELECT * FROM lines')).rows,lines);assert.deepEqual(o.erp_live,{});assert.deepEqual(o.suspension,old.suspension);
 assert.equal((await f.db.query('SELECT status FROM erp_live_jobs')).rows[0].status,'pending');
 const jobs=(await f.db.query('SELECT * FROM resolution_jobs ORDER BY created_at')).rows;assert.equal(jobs.length,2);assert.equal(jobs.find(j=>j.id==='old-job').result.previousReview.error,error);assert.equal(jobs.find(j=>j.id===result.jobId).action,'resume');
 assert.equal((await f.db.query('SELECT detail FROM audit')).rows[0].detail.externalWritesIssued,0);
 await assert.rejects(f.service.prepare(input,user),/modifiée/);assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,2);
});
test('renewal requires explicit confirmation and manager permission',async t=>{
 const f=await fixture(t),input=await f.input();await assert.rejects(f.service.prepare({...input,confirmPreparation:false},user),/Confirmez/);
 await assert.rejects(f.service.prepare(input,{...user,role:'operator'}),/Droits/);
 const oldInput=await f.service.preview(reference);assert.equal((await f.service.prepare({reference,fingerprint:oldInput.fingerprint,confirmPreparation:true},user)).replayed,true);
 assert.equal((await f.read()).source_payload.temuExcelCommercial.total,4.30);
});
test('changing source, mapping, address or suspension after preview prevents renewal',async t=>{
 for(const sql of ["UPDATE lines SET quantity=2","UPDATE lines SET target_sku='other'","UPDATE orders SET address=address||'{\"city\":\"Changed\"}'","UPDATE orders SET suspension='{\"active\":true}'"]){
  await t.test(sql,async t=>{const f=await fixture(t),input=await f.input();await f.db.exec(sql);await assert.rejects(f.service.prepare(input,user),/modifiée/);assert.equal((await f.db.query('SELECT * FROM audit')).rows.length,0);});
 }
});
test('operational and document boundaries cannot be renewed',()=>{
 const job={status:'review',error};assert.equal(excelRenewalCandidate(candidate,job),true);
 for(const patch of [{channel:'tender'},{archived:true},{partial_mode:true},{transport_choice:'gls'},{issue:'Consigne humaine'},{tracking_status:'shipped'},{label_status:'cancelled'},{suspension:{active:true}},{suspension:{erplainCancellation:null}},...['bc','bl','customer','customerNumber','phase'].map(key=>({erp_live:{[key]:key==='phase'?'creating_customer':{id:'existing'}}})),...['marketplacePendingCorrection','manualPreparationRequired','visibilityHold','erplainValidationHold'].map(key=>({source_payload:{...candidate.source_payload,[key]:true}})),{source_payload:{...candidate.source_payload,manualPlatformCancellation:{cancelled:true}}}])assert.equal(excelRenewalCandidate({...candidate,...patch},job),false,JSON.stringify(patch));
 for(const status of ['pending','processing','complete'])assert.equal(excelRenewalCandidate(candidate,{status,error}),false);
 assert.equal(excelRenewalCandidate(candidate,{status:'review',error:'HTTP 500 : résultat inconnu'}),false);
});
test('uncertain writes, unrelated reviews, existing labels and active corrections prevent renewal',async t=>{
 for(const sql of ["INSERT INTO temu_label_jobs VALUES('PO-141-FIXTURE','unknown','[]')","INSERT INTO temu_label_documents VALUES('PO-141-FIXTURE')","INSERT INTO carrier_jobs VALUES('o')","INSERT INTO carrier_label_history VALUES('o')","INSERT INTO partial_deliveries VALUES('o')","INSERT INTO extra_parcels VALUES('o')","INSERT INTO erplain_product_creation_attempts VALUES('6963')","INSERT INTO correction_jobs VALUES('o','review')","INSERT INTO resolution_jobs(id,order_id,action,status,error) VALUES('other','o','replace-equivalent','review','Réponse inconnue')","UPDATE erp_live_jobs SET status='processing'"]){
  await t.test(sql,async t=>{const f=await fixture(t),input=await f.input();await f.db.exec(sql);await assert.rejects(f.service.prepare(input,user),/Revalidation Excel/);assert.equal((await f.read()).source_payload.temuExcelCommercial.total,4.30);});
 }
});
