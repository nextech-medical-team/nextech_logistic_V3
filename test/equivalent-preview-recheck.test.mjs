import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {startSubstitutionAttempt,finishSubstitutionAttempt} from '../src/substitution-attempt.mjs';
import {committedPreviewNeedsRecheck,interruptedPreviewErrors,equivalentPreviewRecheckMessage} from '../src/equivalent-preview-recheck.mjs';
import {attachEquivalentDiagnostics} from '../src/equivalent-diagnostics.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

async function fixture(){
 const pg=new PGlite();await pg.exec(`CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,payload jsonb,result jsonb,error text,stage text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE lines(order_id text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);`);
 const order={id:'o',channel:'shopify',archived:false,erp_live:{bc:{id:'11'},equivalentAttemptId:'first'}};
 const body={id:'o',requestId:'first',sku:'C',replacementSku:'D',replaceQuantity:96,replacementQuantity:96,scope:'order',confirmEquivalent:true,previewFingerprint:'a'.repeat(64)};
 const plan={bcId:'11',commercialBefore:{update_stock:false},originalSku:'C',replacementSku:'D',replaceQuantity:96,replacementQuantity:96,expected:[{sku:'A',quantity:96},{sku:'D',quantity:96}],previewFingerprint:body.previewFingerprint};
 await pg.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,payload,created_at) VALUES('first','o','first','replace-equivalent','running',$1,now()-interval '1 day')",[JSON.stringify(body)]);
 const attempt=await startSubstitutionAttempt(pg,order,body,plan,null);
 await finishSubstitutionAttempt(pg,'o','first',attempt,{equivalent:true});
 await pg.query("UPDATE resolution_jobs SET status='review',error='BL bloqué — stock insuffisant : A : 96 nécessaires, 0 utilisables, manque 96' WHERE id='first'");
 const payload={id:'o',requestId:'second',sku:'A',replacementSku:'B',replaceQuantity:96,replacementQuantity:96,scope:'order'};
 await pg.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,payload,error) VALUES('second','o','second','equivalent-preview','review',$1,$2)",[JSON.stringify(payload),interruptedPreviewErrors[0]]);
 await pg.exec("INSERT INTO lines VALUES('o','A','A',96,96),('o','D','D',96,96)");
 return {pg,order,recorded:(await pg.query("SELECT * FROM resolution_jobs WHERE id='first'")).rows[0],preview:(await pg.query("SELECT * FROM resolution_jobs WHERE id='second'")).rows[0],lines:(await pg.query('SELECT * FROM lines')).rows};
}

test('committed first line makes the failed second preview actionable without reusing confirmation',async()=>{
 const f=await fixture();try{
  assert.equal(committedPreviewNeedsRecheck(f.order,f.preview,f.recorded,f.lines),true);
  for(const error of interruptedPreviewErrors)assert.equal(committedPreviewNeedsRecheck(f.order,{...f.preview,error},f.recorded,f.lines),true);
  const before=(await f.pg.query('SELECT * FROM resolution_jobs ORDER BY id')).rows;
  await attachEquivalentDiagnostics(f.pg,[f.order]);
  assert.equal(f.order.pending_equivalent.error,equivalentPreviewRecheckMessage);
  assert.equal(f.order.pending_equivalent.recheckRequired,true);
  assert.equal(f.order.pending_equivalent.previousError,interruptedPreviewErrors[0]);
  assert.equal(f.order.pending_equivalent.previewFingerprint,undefined);
  assert.equal(f.order.pending_equivalent.confirmEquivalent,undefined);
  assert.deepEqual((await f.pg.query('SELECT * FROM resolution_jobs ORDER BY id')).rows,before);
 }finally{await f.pg.close();}
});

test('uncertain, malformed and diverged local commits retain the original warning',async()=>{
 const f=await fixture();try{
  const variants=[];
  for(const patch of [{phase:'mutation_started'},{planHash:'invalid'},{requestId:'different'},{orderId:'other'},{permanent:{}},{completionResult:null}])variants.push({...f.recorded,payload:{...f.recorded.payload,substitutionAttempt:{...f.recorded.payload.substitutionAttempt,...patch}}});
  for(const status of ['running','waiting','cancelled','complete'])variants.push({...f.recorded,status});
  for(const recorded of variants)assert.equal(committedPreviewNeedsRecheck(f.order,f.preview,recorded,f.lines),false);
  for(const lines of [[],[{...f.lines[0],target_quantity:95},f.lines[1]],[f.lines[0],{...f.lines[1],target_sku:'OTHER'}],[{...f.lines[0],target_quantity:null,quantity:null},f.lines[1]]])assert.equal(committedPreviewNeedsRecheck(f.order,f.preview,f.recorded,lines),false);
  await f.pg.query("UPDATE resolution_jobs SET payload=jsonb_set(payload,'{substitutionAttempt,phase}','\"mutation_started\"') WHERE id='first'");
  await attachEquivalentDiagnostics(f.pg,[f.order]);assert.equal(f.order.pending_equivalent.error,interruptedPreviewErrors[0]);assert.equal(f.order.pending_equivalent.recheckRequired,undefined);
 }finally{await f.pg.close();}
});

test('suspensions, shipping, partials, other choices and provider failures remain blocked',async()=>{
 const f=await fixture();try{
  for(const patch of [{archived:true},{partial_mode:true},{suspension:{active:true}},{resolution_pending_resume:true},{tracking_status:'shipped'},{label_status:'cancelled'},{source_payload:{marketplacePendingCorrection:{}}},{erp_live:{...f.order.erp_live,bl:{id:'22'}}},{erp_live:{...f.order.erp_live,stockDocument:{id:'22'}}},{erp_live:{...f.order.erp_live,equivalentAttemptId:'other'}}])assert.equal(committedPreviewNeedsRecheck({...f.order,...patch},f.preview,f.recorded,f.lines),false);
  for(const patch of [{action:'replace-equivalent'},{status:'complete'},{error:'Produit de remplacement [B] : stock insuffisant'}])assert.equal(committedPreviewNeedsRecheck(f.order,{...f.preview,...patch},f.recorded,f.lines),false);
  for(const patch of [{sku:'C'},{sku:'D'},{scope:'permanent'},{confirmEquivalent:true},{replaceQuantity:0},{replacementQuantity:null},{substitutionAttempt:{}},{sku:'ABSENT'}])assert.equal(committedPreviewNeedsRecheck(f.order,{...f.preview,payload:{...f.preview.payload,...patch}},f.recorded,f.lines),false);
 }finally{await f.pg.close();}
});

test('recheck badge keeps the current stock problem and the chosen replacement visible',()=>{
 const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),ctx);
 const order={sku_lines:[{sku:'A',quantity:96}],resolution_error:interruptedPreviewErrors[0],erp_live_job:{status:'review',error:'BL bloqué — stock insuffisant : A : 96 nécessaires, 63 utilisables, manque 33'},pending_equivalent:{sku:'A',replacementSku:'B',replaceQuantity:96,replacementQuantity:96,error:equivalentPreviewRecheckMessage,recheckRequired:true,previousError:interruptedPreviewErrors[0]}};
 const problems=ctx.compactProblems(order);
 assert.ok(problems.some(p=>p.type==='equivalent-pending'&&p.label==='Vérifier le remplacement'));
 assert.ok(problems.some(p=>p.type==='stock'&&p.sku==='A'));
 assert.ok(!problems.some(p=>p.detail===interruptedPreviewErrors[0]));
 assert.equal(order.resolution_error,interruptedPreviewErrors[0]);
 assert.equal(order.pending_equivalent.replacementSku,'B');
 order.pending_equivalent.error='Produit de remplacement [B] : stock insuffisant. Quantité totale nécessaire : 96 unités ; stock disponible : 13 unités ; quantité manquante : 83 unités.';
 assert.ok(ctx.compactProblems(order).some(p=>p.type==='stock'&&p.sku==='B'&&p.detail.includes('83')));
});
