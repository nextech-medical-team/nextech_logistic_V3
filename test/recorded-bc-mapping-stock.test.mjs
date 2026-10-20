import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {resolveReplacementLines} from '../src/resolution-quantities.mjs';
import {currentMappingLine} from '../src/current-mapping-line.mjs';
import {applyMappingScope} from '../src/mapping-scope.mjs';
import {saveMapping} from '../src/mapping-store.mjs';
import {prepareLabel} from '../src/workflow.mjs';
import {recordedBcRoutingLines} from '../src/recorded-bc-routing-lines.mjs';

const line={id:'local',source_sku:'LSP20061930',quantity:12,target_sku:'LSFE3151-05',target_quantity:360,mapped_sku:'LSFE3151-05',source_qty:1,target_qty:30};
const bc={id:1939214,line_items:[{id:27945412,type:'normal',quantity:360,variant:{id:641966,sku:'LSP20061930'}}]};
const classifier=()=>{const c=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),c);return c;};

test('#12887 replacement selector uses BC units and original SKU instead of the later mapping',()=>{
 const before=structuredClone(line),rows=resolveReplacementLines([line],'shopify',{bc});
 assert.equal(rows.length,1);assert.equal(rows[0].replacement_sku,'LSP20061930');assert.equal(rows[0].replacement_quantity,360);assert.equal(rows[0].recorded_bc_line_id,'27945412');assert.deepEqual(line,before);
 assert.equal(resolveReplacementLines([line],'shopify')[0].replacement_sku,'LSFE3151-05');
});
test('unverified recorded lines never fall back to a replacement that is absent from the BC',()=>{
 for(const patch of [{line_items:[]},{line_items:null},{line_items:[{...bc.line_items[0],quantity:null}]},{line_items:[{...bc.line_items[0],quantity:0}]},{line_items:[{...bc.line_items[0],variant:{}}]}]){
  const row=resolveReplacementLines([line],'shopify',{bc:{...bc,...patch}})[0];assert.equal(row.replacement_sku,null);assert.match(row.replacement_quantity_error,/Relire/);
 }
});
test('BC product lines, not shipping costs or mappings, define complete and partial replacement choices',()=>{
 const mixed={...bc,line_items:[...bc.line_items,{id:'b',type:'normal',variant:{sku:'OTHER'},quantity:40},{id:'shipping',type:'shipping_cost',quantity:1}]};
 const rows=resolveReplacementLines([line],'shopify',{bc:mixed});assert.deepEqual(rows.map(l=>[l.replacement_sku,l.replacement_quantity]),[['LSP20061930',360],['OTHER',40]]);
 const source=readFileSync(new URL('../public/problem-corrections.js',import.meta.url),'utf8');const c=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function equivalentCandidates('),source.indexOf('function openStockEquivalent(')),c);
 assert.equal(c.equivalentCandidates({order:{channel:'shopify',partial_mode:true,partial_allocation:[{sku:'LSP20061930',remaining:60,allocated:300}]},lines:rows})[0].quantity,60);
});
test('stock badge and shared filter identify the failed BC SKU even when source matches a replacement line',()=>{
 const c=classifier(),raw='BL bloqué — stock insuffisant : LSP20061930 : 360 nécessaires, 0 utilisables, manque 360';
 const order={channel:'shopify',erp_status:'live_review',sku_lines:[{sku:'LSFE3151-05',source_sku:'LSP20061930',quantity:360}],erp_live_job:{status:'review',error:raw}};
 const result=c.compactProblems(order);assert.equal(result.length,1);assert.equal(result[0].sku,'LSP20061930');assert.equal(result[0].type,'stock');
 assert.equal(c.compactProblem('Produit de remplacement [LSFE3151-05] : stock insuffisant','LSP20061930').sku,'LSFE3151-05');
 assert.equal(c.compactProblem('Stock insuffisant','KNOWN').sku,'KNOWN');
 const multi=c.compactProblems({...order,erp_live_job:{error:raw+' ; OTHER : 2 nécessaires, 0 utilisables, manque 2'}});assert.deepEqual(Array.from(multi,p=>p.sku),['LSP20061930','OTHER']);
 assert.equal(c.compactProblems({...order,tracking_status:'delivered'}).length,0);
});
test('preserved BC waiting message is hidden while actionable stock shortages remain visible',()=>{
 const c=classifier(),wait='En attente de stock : BC disponible, préparation du BL suspendue';
 const order={channel:'shopify',sku_lines:[],erp_live:{bc:{id:'bc',status:'active'}},erp_live_job:{status:'review',error:wait}};
 assert.equal(c.compactProblems(order).some(p=>p.detail===wait),false);
 const shortage='BL bloqué — stock insuffisant : SKU : 5 nécessaires, 2 utilisables, manque 3';
 const result=c.compactProblems({...order,issue:shortage});
 assert.ok(result.some(p=>p.type==='stock'&&p.sku==='SKU'&&p.detail.includes('manque 3')));
 assert.equal(result.some(p=>p.detail===wait),false);
});
test('order-only mapping after BC is refused before labels, lines or global mappings can be touched',async()=>{
 let reads=0;const db={transaction:f=>f({query:async(sql)=>{assert.match(sql,/SELECT id,erp_live FROM orders.*FOR UPDATE/);reads++;return {rows:[{id:'o',erp_live:{bc:{id:'bc'}}}]};}})};
 await assert.rejects(applyMappingScope(db,{scope:'order',source_qty:1,target_qty:30},'o',()=>assert.fail('no global write')),/Remplacer un produit/);assert.equal(reads,1);
});
test('recorded preparation keeps its saved selection when a future permanent mapping changes',async()=>{
 assert.deepEqual(currentMappingLine({...line,target_sku:'RECORDED',target_quantity:10},'shopify',{recordedBc:true}),{sku:'RECORDED',quantity:10});
 const writes=[];const db={query:async(sql,args)=>{if(sql.startsWith('SELECT l.')){assert.equal(args[2],true);return {rows:[{...line,target_sku:'RECORDED',target_quantity:10,weight_kg:.04}]};}if(sql.startsWith('SELECT value'))return {rows:[]};writes.push({sql,args});return {rows:[]};}};
 await prepareLabel(db,{id:'o',channel:'amazon',reference:'test',erp_live:{bc:{id:'bc'}},address:{name:'Test',street:'Street',postal:'75001',city:'Paris',country:'FR'}});
 assert.equal(writes.some(w=>w.sql.startsWith('UPDATE lines')),false);assert.equal(writes.find(w=>w.sql.startsWith('UPDATE orders SET label_status')).args[1],.4);
});
test('legacy null or divergent target caches cannot change the product or units of a complete BC',async()=>{
 const source=structuredClone(line),db={query:async(sql,args)=>{assert.match(sql,/FROM products p/);assert.deepEqual(args,[['LSP20061930']]);return {rows:[{sku:'LSP20061930',weight_kg:.04}]};}};
 for(const target_sku of [null,'LSFE3151-05']){
  const rows=await recordedBcRoutingLines(db,{channel:'shopify',erp_live:{bc}},[{...line,target_sku,target_quantity:null}]);assert.equal(rows[0].target_sku,'LSP20061930');assert.equal(rows[0].target_quantity,360);assert.equal(rows[0].weight_kg,.04);
 }
 assert.deepEqual(line,source);
});
test('routing preserves partial and AO scopes and never carries a weight proof to a different physical product',async()=>{
 const preserved=[{...line,source_payload:{erplainSourceVariantId:'OTHER',erplainCorrectedWeightKg:999}}];
 for(const patch of [{channel:'tender'},{channel:'shopify',partial_mode:true}])assert.equal(await recordedBcRoutingLines({query:()=>assert.fail('no extra read')},{...patch,erp_live:{bc}},preserved),preserved);
 const rows=await recordedBcRoutingLines({query:async()=>({rows:[{sku:'LSP20061930',weight_kg:.04}]})},{channel:'shopify',erp_live:{bc}},preserved);assert.equal(rows[0].weight_kg,.04);
});
test('routing reuses only a weight verified for the recorded physical variant, without catalog blockers for another product',async()=>{
 const rows=await recordedBcRoutingLines({query:async()=>({rows:[{sku:'LSP20061930',weight_kg:.04,message:'old lookup error'}]})},{channel:'shopify',erp_live:{bc}},[{target_sku:'LSP20061930',source_payload:{erplainSourceVariantId:'641966',erplainCorrectedWeightKg:.05}}]);assert.equal(rows[0].weight_kg,.05);assert.equal(rows[0].message,null);
});
test('real preparation routes legacy BC caches from the recorded SKU without rewriting lines or mappings',async()=>{
 const writes=[],db={query:async(sql,args)=>{
  if(sql.startsWith('SELECT l.'))return {rows:[{...line,target_sku:null,target_quantity:null,weight_kg:999}]};
  if(sql.startsWith('SELECT p.sku'))return {rows:[{sku:'LSP20061930',weight_kg:.04}]};
  if(sql.startsWith('SELECT value'))return {rows:[]};writes.push({sql,args});return {rows:[]};
 }};
 await prepareLabel(db,{id:'o',reference:'test',channel:'shopify',source_payload:{shopifyDeliveryMode:'direct'},transport_choice:'gls',erp_live:{bc},address:{name:'Test',street:'Street',postal:'75001',city:'Paris',country:'FR'}});
 assert.equal(writes.some(w=>w.sql.startsWith('UPDATE lines')),false);assert.equal(writes.find(w=>w.sql.startsWith('UPDATE orders SET label_status')).args[1],14.4);
});
test('real permanent mapping SQL preserves all BC orders, their lines and jobs while preparing unrecorded orders',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE orders(id text primary key,channel text,suspension jsonb default '{}',archived boolean default false,partial_mode boolean default false,tracking_status text default 'not_shipped',erp_live jsonb default '{}');CREATE TABLE lines(id text,order_id text,source_sku text,target_sku text,target_quantity numeric,source_payload jsonb default '{}');CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric,notes text,updated_at timestamptz,primary key(channel,source_sku));CREATE TABLE jobs(order_id text,kind text,status text,available_at timestamptz,error text);CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text,status text,result jsonb,tracking jsonb default '[]');`);
  for(const [id,state]of [['new',{}],['bc',{bc:{id:'B',status:'active'}}],['bl',{bc:{id:'B',status:'active'},bl:{id:'S'}}]]){
   await db.query('INSERT INTO orders(id,channel,erp_live) VALUES($1,$2,$3)',[id,'shopify',JSON.stringify(state)]);await db.query("INSERT INTO lines VALUES($1,$1,'SOURCE','ORIGINAL',360,'{}')",[id]);await db.query("INSERT INTO jobs VALUES($1,'label','review',now(),'preserve')",[id]);
  }
  const before=(await db.query("SELECT * FROM lines WHERE order_id<>'new' ORDER BY id")).rows;
  const result=await saveMapping(db,{channel:'shopify',source_sku:'SOURCE',target_sku:'NEXT',source_qty:1,target_qty:30});assert.deepEqual(result.affected,['new']);
  assert.deepEqual((await db.query("SELECT * FROM lines WHERE order_id<>'new' ORDER BY id")).rows,before);assert.equal((await db.query("SELECT target_sku FROM lines WHERE order_id='new'")).rows[0].target_sku,null);
  assert.ok((await db.query("SELECT status,error FROM jobs WHERE order_id<>'new'")).rows.every(j=>j.status==='review'&&j.error==='preserve'));assert.equal((await db.query('SELECT target_sku FROM mappings')).rows[0].target_sku,'NEXT');
 }finally{await db.close();}
});
