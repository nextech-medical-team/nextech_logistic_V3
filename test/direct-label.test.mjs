import test from 'node:test';
import assert from 'node:assert/strict';
import {queueLabelFromBl,assertBlLabelWorker,queueLabelBatchFromBl} from '../src/direct-label.mjs';
const base={id:'target',channel:'amazon',carrier:'gofo',address:{country:'FR'},erp_live:{bl:{id:1902751,status:'ready_to_ship'},pricing:{status:'blocked'}},resolution_pending_resume:true};
function database({order=structuredClone(base),job=null,docs=false,active=false}={}){
 let tail=Promise.resolve();const calls=[];let inserts=0;
 const db={calls,get inserts(){return inserts;},transaction(fn){const run=tail.then(()=>fn(db));tail=run.catch(()=>{});return run;},async query(sql,args){calls.push(sql);
 if(sql==='SELECT * FROM orders WHERE id=$1 FOR UPDATE')return {rows:[order]};
 if(sql==='SELECT * FROM carrier_jobs WHERE order_id=$1 FOR UPDATE')return {rows:job?[job]:[]};
 if(sql.startsWith('SELECT 1 FROM carrier_documents'))return {rows:docs?[{}]:[]};
 if(sql.startsWith('SELECT 1 FROM resolution_jobs'))return {rows:active?[{}]:[]};
 if(sql.startsWith('INSERT INTO carrier_jobs')){inserts++;job={status:'pending'};return {rows:[]};}
 return {rows:[]};}};return db;
}
test('BL présent : aucune lecture ERP, stock, prix ou empreinte de préparation',async()=>{const db=database();assert.equal((await queueLabelFromBl(db,'target',{email:'operator'})).status,'pending');assert.equal(db.inserts,1);assert(!db.calls.some(q=>/erp_live_jobs|products|stock_cache|FROM lines/.test(q)));});
test('commande cible : ancien échec local du gate repris sans nouveau contrôle fiscal',async()=>{const db=database({job:{status:'failed',attempts:1,tracking:[],error:'Préparation modifiée depuis la validation du BL : recontrôler'}});await queueLabelFromBl(db,'target',{email:'operator'});assert.equal(db.inserts,1);});
test('double clic concurrent : une seule création',async()=>{const db=database();const result=await Promise.all([queueLabelFromBl(db,'target',{email:'operator'}),queueLabelFromBl(db,'target',{email:'operator'})]);assert.equal(db.inserts,1);assert.equal(result.filter(r=>r.existing).length,1);});
for(const job of [{status:'ready'},{status:'creating'},{status:'awaiting_pdf'},{status:'pending'}])test('préserver job '+job.status,async()=>{const db=database({job});assert.equal((await queueLabelFromBl(db,'target',{email:'operator'})).existing,true);assert.equal(db.inserts,0);});
for(const job of [{status:'review'},{status:'failed',attempts:1,error:'Timeout'},{status:'failed',attempts:0,result:{reference:'existing'}},{status:'failed',attempts:0,tracking:['existing']},{status:'failed',attempts:0,reference:'existing'}])test('refuser résultat ou tentative incertaine '+JSON.stringify(job),async()=>{const db=database({job});await assert.rejects(queueLabelFromBl(db,'target',{email:'operator'}));assert.equal(db.inserts,0);});
for(const patch of [{channel:'temu',transport_choice:'gofo'},{suspension:{active:true,note:'client'}},{partial_mode:true},{archived:true},{tracking_status:'shipped'},{erp_live:{bl:{id:1,status:'cancelled'}}},{erp_live:{}},{carrier:null}])test('préserver interdiction '+JSON.stringify(patch),async()=>{const db=database({order:{...base,...patch}});await assert.rejects(queueLabelFromBl(db,'target',{email:'operator'}));assert.equal(db.inserts,0);});
test('PDF et modification active conservés',async()=>{for(const opts of [{docs:true},{active:true}]){const db=database(opts);await assert.rejects(queueLabelFromBl(db,'target',{email:'operator'}));assert.equal(db.inserts,0);}});
test('worker direct : BL identique, fiscalité bloquée et empreinte absente acceptés',()=>assertBlLabelWorker(base,{blId:'1902751',requestedBy:'operator',at:'now'}));
test('worker refuse changement de BL après demande',()=>assert.throws(()=>assertBlLabelWorker(base,{blId:'other',requestedBy:'operator',at:'now'})));
test('sélection manuelle : déduplication et même admission directe',async()=>{const db=database();const r=await queueLabelBatchFromBl(db,['target','target'],{email:'operator'});assert.equal(r.queued,1);assert.deepEqual(r.skipped,[]);assert.equal(db.inserts,1);});
test('sélection protégée : motif courant rendu sans nouvelle création',async()=>{const db=database({order:{...base,channel:'temu'}});const r=await queueLabelBatchFromBl(db,['target'],{email:'operator'});assert.equal(r.queued,0);assert.equal(r.skipped.length,1);assert.match(r.message,/TEMU/);});
test('limite de sélection maintenue',async()=>{await assert.rejects(queueLabelBatchFromBl(database(),Array(101).fill('target'),{email:'operator'}));});
