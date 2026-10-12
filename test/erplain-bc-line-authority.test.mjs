import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {adoptErplainBcLines,bcAuthorityLineVersion,bcAuthorityIdentityMatches,authoritativeBcLines} from '../src/erplain-bc-line-authority.mjs';
import {reconcileRefreshedBcDiagnostics} from '../src/bc-comparison-refresh.mjs';
import {refreshErplainDocuments} from '../src/erplain-documents-sync.mjs';
import {currentMappingLine} from '../src/current-mapping-line.mjs';
const fixtures=JSON.parse((await fs.readFile(new URL('fixtures/bc-refresh/cases.json',import.meta.url),'utf8')).replace(/^\uFEFF/,''));
const clone=structuredClone;
async function setup(ref='2610813'){
 const entry=clone(fixtures.orders.find(o=>o.reference===ref)),db=new PGlite();
 await db.exec(`CREATE TABLE orders(id text primary key,channel text,reference text,erp_live jsonb,source_payload jsonb,partial_mode boolean,issue text,suspension jsonb,archived boolean default false);
 CREATE TABLE lines(id text primary key,order_id text,source_line text,source_sku text,quantity numeric,target_sku text,target_quantity numeric,source_payload jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE carrier_jobs(order_id text,status text);
 CREATE TABLE resolution_jobs(id text primary key,order_id text,status text,action text,error text,result jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 CREATE TABLE partial_deliveries(id text,order_id text,status text,bl jsonb,stock_document jsonb,selection jsonb,error text,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 const o=entry.order;
 await db.query('INSERT INTO orders(id,channel,reference,erp_live,source_payload,partial_mode,issue,suspension) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[entry.id,o.channel,ref,JSON.stringify(o.erp_live),JSON.stringify(o.source_payload||{}),!!o.partial_mode,o.issue||null,JSON.stringify(o.suspension||null)]);
 for(const [i,l] of entry.lines.entries())await db.query('INSERT INTO lines VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[l.id||'line-'+i,entry.id,String(l.source_line||i),l.source_sku,l.quantity,l.target_sku,l.target_quantity,JSON.stringify(l.source_payload||{})]);
 for(const [i,j] of entry.jobs.entries())await db.query('INSERT INTO resolution_jobs(id,order_id,status,action,error,result) VALUES($1,$2,$3,$4,$5,$6)',[j.id||'job-'+i,entry.id,j.status,j.action,j.error,JSON.stringify(j.result||{})]);
 const order=async()=>(await db.query('SELECT * FROM orders WHERE id=$1',[entry.id])).rows[0];
 const lines=async()=>(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY id',[entry.id])).rows;
 const adopt=async(bc=entry.bc,version)=>{const expected=version??bcAuthorityLineVersion(await lines());return db.transaction(tx=>adoptErplainBcLines(tx,entry.id,bc,expected));};
 const api={verify:async()=>{},request:async(q,v)=>{assert.match(q,/^query /);assert.equal(String(v.id),String(entry.bc.id));return {Order:clone(entry.bc)}}};
 return {entry,db,order,lines,adopt,api};
}
for(const ref of ['2610813','PH2/00638941','Q1936380'])test('SQL réel : reprise des produits BC, import et documents conservés '+ref,async()=>{
 const f=await setup(ref);try{
 const before=await f.order(),original=await f.lines(),result=await f.adopt(),after=await f.order(),lines=await f.lines();
 assert.equal(result.changed,true);assert.equal(bcAuthorityIdentityMatches(after,f.entry.bc,lines),true);
 assert.deepEqual(lines.map(l=>[l.source_sku,Number(l.quantity)]),original.map(l=>[l.source_sku,Number(l.quantity)]));
 assert.deepEqual(after.source_payload,before.source_payload);
 for(const key of ['bc','bl','stockDocument','pricing','label','tracking'])assert.deepEqual(after.erp_live[key],before.erp_live[key]);
 const compared=await f.db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,f.entry.id,f.entry.bc));assert.equal(compared.concordant,true);
 if(ref==='2610813'){assert.equal(lines[0].target_sku,'FLP1915');assert.equal(Number(lines[0].target_quantity),10);assert.equal(lines[0].source_payload.erplainSourceVariantId,'641797');}
 const audited=(await f.db.query('SELECT * FROM audit')).rows.length;assert.equal((await f.adopt()).changed,false);assert.equal((await f.db.query('SELECT * FROM audit')).rows.length,audited);
 }finally{await f.db.close();}
});
test('SQL réel : changement de quantité, ajout et suppression avec historique',async()=>{
 const f=await setup();try{
 const bc=clone(f.entry.bc);bc.line_items[0].quantity=7;bc.line_items.push({...clone(bc.line_items[0]),id:99991,quantity:3,variant:{id:99992,sku:'SECOND'}});
 await f.adopt(bc);let lines=await f.lines();assert.deepEqual(lines.map(l=>[l.target_sku,Number(l.target_quantity)]).sort(),[['FLP1915',7],['SECOND',3]]);
 await f.adopt({...bc,line_items:[bc.line_items[1]]});lines=await f.lines();assert.equal(lines.length,1);assert.equal(lines[0].target_sku,'SECOND');
 const audit=(await f.db.query('SELECT detail FROM audit')).rows;assert.equal(audit[1].detail.before.length,2);assert.equal(audit[1].detail.after.length,1);assert.equal(audit[1].detail.labelsTouched,0);
 }finally{await f.db.close();}
});
for(const invalid of [null,true,'',-1,'abc'])test('BC invalide sans mutation SQL : quantité '+String(invalid),async()=>{
 const f=await setup();try{const before=await f.lines(),bc=clone(f.entry.bc);bc.line_items[0].quantity=invalid;await assert.rejects(f.adopt(bc));assert.deepEqual(await f.lines(),before);assert.equal((await f.db.query('SELECT * FROM audit')).rows.length,0);}finally{await f.db.close();}
});
for(const invalid of [0,-1,'bad',null])test('variante invalide sans adoption '+String(invalid),async()=>{
 const f=await setup();try{const bc=clone(f.entry.bc);bc.line_items[0].variant.id=invalid;await assert.rejects(f.adopt(bc));}finally{await f.db.close();}
});
test('concurrence SQL et activité en cours : ne pas remplacer les lignes',async()=>{
 const f=await setup();try{
 const version=bcAuthorityLineVersion(await f.lines());await f.db.query('UPDATE lines SET target_quantity=11 WHERE order_id=$1',[f.entry.id]);await assert.rejects(f.adopt(f.entry.bc,version),/modifiées pendant/);
 await f.db.query("INSERT INTO carrier_jobs VALUES($1,'creating')",[f.entry.id]);await assert.rejects(f.adopt(),/Traitement en cours/);assert.equal((await f.db.query('SELECT * FROM audit')).rows.length,0);
 }finally{await f.db.close();}
});
test('projection BC explicite prévaut sur un ancien mapping permanent',async()=>{
 const f=await setup();try{await f.adopt();const l=(await f.lines())[0];const mapped=currentMappingLine({...l,mapped_sku:'OLD',source_qty:1,target_qty:100},f.entry.order.channel);assert.equal(mapped.sku,'FLP1915');assert.equal(mapped.quantity,10);}finally{await f.db.close();}
});
test('parcours complet bouton BC partiel : actualisation atomique et documents conservés',async()=>{
 const f=await setup();try{const before=await f.order();const result=await refreshErplainDocuments(f.db,f.api,f.entry.id,{adoptBcLines:true});assert.equal(result.adoptedLines.changed,true);assert.equal(result.comparison.concordant,true);const after=await f.order();assert.equal((await f.lines())[0].target_sku,'FLP1915');assert.deepEqual(after.erp_live.bl,before.erp_live.bl);assert.deepEqual(after.source_payload,before.source_payload);}finally{await f.db.close();}
});
test('actualisation périodique sans adoption : divergence conservée',async()=>{
 const f=await setup();try{const before=await f.lines();const result=await refreshErplainDocuments(f.db,f.api,f.entry.id);assert.equal(result.comparison.concordant,false);assert.deepEqual(await f.lines(),before);assert.equal((await f.db.query('SELECT * FROM audit')).rows.length,0);}finally{await f.db.close();}
});
test('changement de variante après adoption : identité de nouveau non confirmée',async()=>{
 const f=await setup();try{await f.adopt();const bc=clone(f.entry.bc);bc.line_items[0].variant.id=987;assert.equal(bcAuthorityIdentityMatches(await f.order(),bc,await f.lines()),false);}finally{await f.db.close();}
});
test('bouton BC sur import Erplain avec BL pending : conserver le reliquat et le source historique',async()=>{
 const f=await setup();try{
 await f.db.exec(`ALTER TABLE orders ADD COLUMN address jsonb default '{}', ADD COLUMN recipient text, ADD COLUMN erplain_refresh jsonb default '{}', ADD COLUMN resolution_pending_resume boolean default false;
 ALTER TABLE carrier_jobs ADD COLUMN result jsonb, ADD COLUMN tracking jsonb default '[]', ADD COLUMN error text, ADD COLUMN updated_at timestamptz;
 CREATE TABLE carrier_documents(order_id text);`);
 f.entry.bc.shipping_orders.data[0].status='pending';
 const before=await f.order();await f.db.query('UPDATE orders SET partial_mode=false,source_payload=$2,issue=null,erp_live=$3 WHERE id=$1',[f.entry.id,JSON.stringify({erplainImported:true,account:'live'}),JSON.stringify({...before.erp_live,bl:f.entry.bc.shipping_orders.data[0]})]);
 const original=await f.lines();const result=await refreshErplainDocuments(f.db,f.api,f.entry.id,{adoptBcLines:true});
 assert.equal(result.comparison.concordant,true);const after=await f.order();assert.equal(after.erp_live.bcLineAuthority.source,'erplain_bc');assert.equal(after.erp_live.bc.id,f.entry.bc.id);
 assert.equal((await f.lines())[0].source_sku,original[0].source_sku);assert.equal((await f.lines())[0].source_line,original[0].source_line);assert.equal((await f.lines())[0].target_sku,'FLP1915');
 }finally{await f.db.close();}
});
test('parcours bouton BC non partiel : quantité modifiée et source conservée',async()=>{
 const f=await setup();try{
 f.entry.bc.shipping_orders.data=[];f.entry.bc.line_items[0].quantity=12;
 await f.db.query("UPDATE orders SET partial_mode=false,issue=null,erp_live=erp_live-'bl'-'stockDocument' WHERE id=$1",[f.entry.id]);
 const result=await refreshErplainDocuments(f.db,f.api,f.entry.id,{adoptBcLines:true});assert.equal(result.comparison.concordant,true);assert.equal(Number((await f.lines())[0].target_quantity),12);assert.equal(Number((await f.lines())[0].quantity),10);
 }finally{await f.db.close();}
});
test('API interrompue pendant le clic : ni documents ni lignes partiellement modifiés',async()=>{
 const f=await setup();try{const before=await f.order(),lines=await f.lines();f.api.request=async()=>{throw Error('Lecture Erplain indisponible')};await assert.rejects(refreshErplainDocuments(f.db,f.api,f.entry.id,{adoptBcLines:true}),/indisponible/);assert.deepEqual(await f.order(),before);assert.deepEqual(await f.lines(),lines);}finally{await f.db.close();}
});
test('erreur variante ERP : retirer après adoption prouvée, rétablir si même SKU autre variante',async()=>{
 const f=await setup();try{
 await f.db.query("INSERT INTO resolution_jobs(id,order_id,status,action,error,result) VALUES('identity',$1,'review','resume',$2,'{}')",[f.entry.id,'BC · Produits ou quantités des lignes Erplain différents de la source']);
 await f.adopt();await f.db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,f.entry.id,f.entry.bc));assert.equal((await f.db.query("SELECT error FROM resolution_jobs WHERE id='identity'")).rows[0].error,null);
 const bc=clone(f.entry.bc);bc.line_items[0].variant.id=987;bc.shipping_orders.data=[];const result=await f.db.transaction(tx=>reconcileRefreshedBcDiagnostics(tx,f.entry.id,bc));assert.equal(result.concordant,false);assert.ok((await f.db.query("SELECT error FROM resolution_jobs WHERE id='identity'")).rows[0].error);
 }finally{await f.db.close();}
});
test('performance : normaliser 1000 lignes BC sans appels externes',()=>{
 const entry=clone(fixtures.orders.find(o=>o.reference==='2610813'));entry.bc.shipping_orders.data=[];entry.bc.line_items=Array.from({length:1000},(_,i)=>({...entry.bc.line_items[0],id:100000+i,variant:{id:200000+i,sku:'SKU-'+i},quantity:1}));const start=performance.now();for(let i=0;i<50;i++)assert.equal(authoritativeBcLines(entry.order,entry.bc).length,1000);assert.ok(performance.now()-start<2000);
});