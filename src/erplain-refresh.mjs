import {usesRecordedBc} from './existing-bc-execution.mjs';
import {targetedOrderService} from './erplain-targeted-orders.mjs';
import {initializeManualReview,queueManualReview,manualReviewService} from './erplain-manual-validation.mjs';
import {manualOrderFields,listManualOrders,manualImportIssue} from './manual-erplain-orders.mjs';
import {shippingProductLines} from './erplain-shipping-lines.mjs';
import {randomUUID} from 'node:crypto';
import {erplainAccount} from './erplain-accounts.mjs';
import {bindProduct} from './product-bindings.mjs';
import {recheckOrders} from './problem-resolution.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {assertFullOrderStock} from './stock-gate.mjs';

export const refreshSections={products:'Produits / SKU',weights:'Poids produits',stocks:'Stocks par emplacement',customers:'Clients et adresses',orders:'Commandes / BC',deliveries:'Livraisons / BL'};
const address='id label address_1 address_2 postal_code city country phone';
const variants='id sku active weight_amount weight_unit track_inventory tax_codes{id} product{id label active}';
export const refreshSpecs={
 products:{root:'Variants',type:'QueryVariantsWhereWhereConditions',column:'SKU',key:'sku',fields:variants,size:100},
 weights:{root:'Variants',type:'QueryVariantsWhereWhereConditions',column:'SKU',key:'sku',fields:variants,size:100},
 stocks:{root:'Variants',type:'QueryVariantsWhereWhereConditions',column:'SKU',key:'sku',fields:'id sku label active on_hand available stock_levels(first:50){data{id location{id label} on_hand available reserved incoming} paginatorInfo{hasMorePages}}',size:100},
 customers:{root:'Customers',type:'QueryCustomersWhereWhereConditions',column:'CUSTOMER_NUMBER',key:'customer_number',fields:`id label customer_number email active default_shipping_address{${address}} default_billing_address{${address}} addresses(first:100){data{${address}} paginatorInfo{hasMorePages}}`,size:20},
 orders:{root:'Orders',type:'QueryOrdersWhereWhereConditions',column:'EXTERNAL_REFERENCE',key:'external_reference',fields:`id label external_reference dated_at status update_stock currency{id label} customer{id label} account_representative{id label} shipping_address{${address}} line_items{id type label description quantity shipped_quantity price reserved_quantity available on_hand location{id} variant{id sku track_inventory}}`,size:5},
 deliveries:{root:'ShippingOrders',type:'QueryShippingOrdersWhereWhereConditions',column:'EXTERNAL_REFERENCE',key:'external_reference',fields:`id label external_reference status update_stock shipping_address{${address}} line_items{id parent_id quantity location{id} variant{id sku}} orders(first:100){data{id} paginatorInfo{hasMorePages}}`,size:5}
};
export function refreshInput(b){
 if(b.manualOrders)throw Error('Reprise des anciennes commandes ERPLAIN suspendue : instruction spécifique requise');
 if(!['live','source'].includes(b.account))throw Error('Choisir Erplain LIVE');
 const sections=b.sections==='all'?Object.keys(refreshSections):b.sections;
 if(!Array.isArray(sections)||!sections.length||sections.some(s=>!refreshSections[s])||new Set(sections).size!==sections.length)throw Error('Sections à actualiser invalides');
 const targets=Array.isArray(b.targets)?b.targets:String(b.targets||'').split(/[\n;,]+/);
 const clean=[...new Set(targets.map(x=>String(x).trim()).filter(Boolean))];
 if(clean.length>100||clean.some(x=>x.length>200))throw Error('Maximum 100 références de 200 caractères');
 if(clean.length&&sections.length!==1)throw Error('Pour cibler des références, sélectionner une seule section');
 if(sections.includes('orders'))throw Error('Récupérer un seul BC depuis le parcours Commandes Erplain');
 if(!/^[a-f0-9-]{36}$/i.test(b.requestId||''))throw Error('Identifiant de demande requis');
 if(b.manualOrders && (b.account!=='live'||sections.length!==1||sections[0]!=='orders'))throw Error('Import des commandes : Erplain LIVE uniquement');
 return {...(b.manualOrders?{manualOrders:true}:{}),account:b.account,sections:Object.keys(refreshSections).filter(s=>sections.includes(s)),targets:clean,requestId:b.requestId};
}
export async function initializeErplainRefresh(db){await db.exec(`
 CREATE TABLE IF NOT EXISTS erplain_refresh_jobs(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,account TEXT NOT NULL,status TEXT NOT NULL,payload JSONB NOT NULL,progress JSONB NOT NULL DEFAULT '{}',result JSONB NOT NULL DEFAULT '[]',error TEXT,requested_by TEXT NOT NULL,cancel_requested BOOLEAN NOT NULL DEFAULT false,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS erplain_refresh_single ON erplain_refresh_jobs((true)) WHERE status IN ('queued','running');
 CREATE TABLE IF NOT EXISTS erplain_refresh_cache(account TEXT NOT NULL,section TEXT NOT NULL,entity_id TEXT NOT NULL,reference TEXT,detail JSONB NOT NULL,seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),missing BOOLEAN NOT NULL DEFAULT false,PRIMARY KEY(account,section,entity_id));
 CREATE TABLE IF NOT EXISTS erplain_refresh_sections(account TEXT NOT NULL,section TEXT NOT NULL,last_success TIMESTAMPTZ,last_job TEXT,last_result JSONB NOT NULL DEFAULT '{}',PRIMARY KEY(account,section));
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS erplain_refresh JSONB NOT NULL DEFAULT '{}';
 `);await initializeManualReview(db);if(db.recoverInterrupted!==false)await db.query("UPDATE erplain_refresh_jobs SET status='interrupted',error='Synchronisation interrompue. Les sections terminées sont conservées ; relancer les autres.' WHERE status='running'");}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function businessChannel(label=''){const v=label.toLowerCase();return v.includes('amazon')?'amazon':v.includes('temu')?'temu':v.includes('boutique')||v.includes('relais')?'shopify':v.includes('offre')?'tender':v.includes('chantillon')?'samples':'erplain';}
function orderAddress(a={},name=''){return {name:a.label||name,street:[a.address_1,a.address_2].filter(Boolean).join(' '),city:a.city||'',postal:a.postal_code||'',country:a.country||'',phone:a.phone||'',email:''};}
export function erplainRefreshService(db,directory,{apiFactory=account=>erplainAccount(directory,account),project=true}={}){
 let running=false;
 async function start(body,user){const input=refreshInput(body);return db.transaction(async tx=>{
  const existing=(await tx.query('SELECT * FROM erplain_refresh_jobs WHERE request_id=$1',[input.requestId])).rows[0];if(existing){if(!same(existing.payload,input))throw Error('Identifiant déjà utilisé pour une autre actualisation');return existing;}
  const active=(await tx.query("SELECT * FROM erplain_refresh_jobs WHERE status IN ('queued','running')")).rows[0];if(active)throw Error('Une actualisation Erplain est déjà en cours ('+(active.account==='live'?'LIVE':'LIVE')+').');
  const id=randomUUID();await tx.query("INSERT INTO erplain_refresh_jobs(id,request_id,account,status,payload,requested_by) VALUES($1,$2,$3,'queued',$4,$5)",[id,input.requestId,input.account,JSON.stringify(input),user.email]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.refresh.requested',$2)",[user.email,JSON.stringify({id,...input})]);return (await tx.query('SELECT * FROM erplain_refresh_jobs WHERE id=$1',[id])).rows[0];
 });}
 async function status(account){if(!['live','source'].includes(account))throw Error('Compte invalide');return {sections:(await db.query('SELECT * FROM erplain_refresh_sections WHERE account=$1',[account])).rows,history:(await db.query('SELECT * FROM erplain_refresh_jobs WHERE account=$1 ORDER BY created_at DESC LIMIT 20',[account])).rows,active:(await db.query("SELECT id,account,status FROM erplain_refresh_jobs WHERE status IN ('queued','running') LIMIT 1")).rows[0]||null};}
 async function data(account,section,search='',page=1){if(!refreshSections[section]||!['live','source'].includes(account))throw Error('Section invalide');page=Math.max(1,Math.min(10000,Number(page)||1));const q='%'+String(search).slice(0,200)+'%',params=[account,section,q];const total=Number((await db.query('SELECT count(*) n FROM erplain_refresh_cache WHERE account=$1 AND section=$2 AND (reference ILIKE $3 OR detail->>\'label\' ILIKE $3)',params)).rows[0].n);return {rows:(await db.query('SELECT * FROM erplain_refresh_cache WHERE account=$1 AND section=$2 AND (reference ILIKE $3 OR detail->>\'label\' ILIKE $3) ORDER BY reference,entity_id LIMIT 50 OFFSET $4',[...params,(page-1)*50])).rows,total,page,pages:Math.max(1,Math.ceil(total/50))};}
 async function checkpoint(job,progress){const current=(await db.query('SELECT cancel_requested FROM erplain_refresh_jobs WHERE id=$1',[job.id])).rows[0];if(current.cancel_requested)throw Error('Actualisation arrêtée à votre demande');await db.query('UPDATE erplain_refresh_jobs SET progress=$2,updated_at=now() WHERE id=$1',[job.id,JSON.stringify(progress)]);}
 async function readSection(api,job,section){const spec=job.payload.manualOrders&&section==='orders'?{...refreshSpecs.orders,fields:manualOrderFields}:refreshSpecs[section],records=[],seen=new Set();let page=1,total=0;
  do{await checkpoint(job,{section,phase:'Lecture API',done:records.length,total,page});
   const query=`query V3Refresh_${section}($page:Int!,$where:${spec.type}){${spec.root}(first:${spec.size},page:$page,where:$where){data{${spec.fields}} paginatorInfo{total lastPage hasMorePages}}}`;
   const where=job.payload.targets.length?(job.payload.manualOrders?{OR:[{column:'LABEL',operator:'IN',value:job.payload.targets},{column:'EXTERNAL_REFERENCE',operator:'IN',value:job.payload.targets}]}:{column:spec.column,operator:'IN',value:job.payload.targets}):undefined;
   const result=await api.request(query,{page,...(where?{where}:{})});const group=result?.[spec.root];
   if(!Array.isArray(group?.data)||typeof group.paginatorInfo?.hasMorePages!=='boolean')throw Error('API Erplain · Réponse '+refreshSections[section]+' incomplète');
   total=Number(group.paginatorInfo.total);if(!Number.isFinite(total))throw Error('API Erplain · Total non reçu');
   for(const v of group.data){if(v.id==null||seen.has(String(v.id)))throw Error('Pagination incohérente : référence absente ou répétée');seen.add(String(v.id));
    if(section==='stocks'&&(!Array.isArray(v.stock_levels?.data)||v.stock_levels.paginatorInfo?.hasMorePages))throw Error('API Erplain · Emplacements incomplets pour '+v.sku);
    if(section==='deliveries'&&(!Array.isArray(v.orders?.data)||v.orders.paginatorInfo?.hasMorePages))throw Error('API Erplain · BC associés incomplets pour '+v.label);
    if(section==='customers'&&(!Array.isArray(v.addresses?.data)||v.addresses.paginatorInfo?.hasMorePages))throw Error('API Erplain · Adresses incomplètes pour '+v.label);
    records.push(v);
   }
   await checkpoint(job,{section,phase:'Lecture API',done:records.length,total,page});if(!group.paginatorInfo.hasMorePages)break;
   if(!group.data.length||page++>10000)throw Error('Pagination Erplain incohérente');
  }while(true);
  if(records.length!==total)throw Error('Données Erplain modifiées pendant la lecture : relancer cette section');return records;
 }
 async function cache(job,section,records){return db.transaction(async tx=>{
  const old=(await tx.query('SELECT * FROM erplain_refresh_cache WHERE account=$1 AND section=$2',[job.account,section])).rows;const byId=new Map(old.map(v=>[v.entity_id,v]));const result={section,status:'complete',read:records.length,added:0,updated:0,unchanged:0,missing:0,localOrdersAdded:0,protected:0,warnings:[],notFound:[],diagnostics:0};const ids=new Set();
  for(const v of records){const id=String(v.id),previous=byId.get(id);ids.add(id);result[!previous?'added':same(previous.detail,v)&&!previous.missing?'unchanged':'updated']++;
   await tx.query('INSERT INTO erplain_refresh_cache(account,section,entity_id,reference,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account,section,entity_id) DO UPDATE SET reference=excluded.reference,detail=excluded.detail,seen_at=now(),missing=false',[job.account,section,id,String(v[refreshSpecs[section].key]||v.label||id),JSON.stringify(v)]);
  }
  for(const o of old)if(!ids.has(o.entity_id)&&(!job.payload.targets.length||job.payload.targets.includes(o.reference)||job.payload.manualOrders&&job.payload.targets.includes(o.detail?.label))){await tx.query('UPDATE erplain_refresh_cache SET missing=true,seen_at=now() WHERE account=$1 AND section=$2 AND entity_id=$3',[job.account,section,o.entity_id]);result.missing++;}
  result.notFound=job.payload.targets.filter(t=>!records.some(r=>String(r[refreshSpecs[section].key])===t||job.payload.manualOrders&&String(r.label)===t));return result;
 });}
 async function applyProducts(job,section,records,result){
  if(job.account!=='live')return;const groups=new Map();for(const v of records){if(!v.sku)continue;groups.set(v.sku,[...(groups.get(v.sku)||[]),v]);}
  const bindings=(await db.query('SELECT * FROM erplain_product_bindings')).rows;
  for(const b of bindings)if(!groups.has(b.sku)&&(!job.payload.targets.length||job.payload.targets.includes(b.sku)))groups.set(b.sku,[]);
  for(const [sku,rows]of groups){const binding=bindings.find(b=>b.sku===sku),active=rows.filter(v=>v.active!==false&&v.product?.active!==false);const v=binding?active.find(v=>String(v.id)===binding.live_variant_id):(active.length===1?active[0]:null);
   if(v){await bindProduct(db,v);}
   else{const message=sku+' : '+(!rows.length?'SKU Erplain introuvable':!active.length?'Produit inactif dans Erplain':binding?'Produit Erplain associé absent ou inactif : vérifier le produit choisi':'SKU en doublon dans Erplain');await db.query('DELETE FROM products WHERE sku=$1',[sku]);await db.query('DELETE FROM product_weight_overrides WHERE sku=$1',[sku]);await db.query('INSERT INTO catalog_results(sku,message) VALUES($1,$2) ON CONFLICT(sku) DO UPDATE SET message=excluded.message,checked_at=now()',[sku,message]);result.warnings.push(message);}
  }
  return [...groups.keys()];
 }
 async function applyDocuments(job,section,records,result){const affected=[];if(job.account!=='live')return affected;
  for(const document of records){const key=section==='orders'?'bc':'bl';let matches=(await db.query(`SELECT * FROM orders WHERE erp_live->$1->>'id'=$2`,[key,String(document.id)])).rows;
   if(section==='deliveries'&&!matches.length){const bcIds=document.orders.data.map(x=>String(x.id));const candidates=(await db.query("SELECT * FROM orders WHERE erp_live->'bc'->>'id'=ANY($1::text[]) AND NOT archived",[bcIds])).rows;
    for(const o of candidates){const related=records.filter(d=>d.orders.data.some(b=>String(b.id)===String(o.erp_live.bc.id)));
     if(related.length===1&&!o.erp_live.bl?.id)matches.push(o);
     else{result.warnings.push(o.reference+' : plusieurs BL ou BL différent, consulter les livraisons synchronisées');await db.query('UPDATE orders SET erplain_refresh=erplain_refresh||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({deliveries:related.map(d=>({id:d.id,label:d.label,status:d.status})),issues:['BL Erplain multiples ou modifiés : vérifier les livraisons']})]);}
    }
   }
   if(section==='orders'&&!matches.length){
    const ref=String(document.external_reference||document.label||'').trim();if(!ref||ref.startsWith('DEMO-')||String(document.status)==='cancelled')continue;
    await queueManualReview(db,document);result.pendingValidation=(result.pendingValidation||0)+1;continue;
   }
   for(const o of matches){if(o.archived)continue;
    const busy=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing') UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf')",[o.id])).rows.length;
    if(busy){result.protected++;result.warnings.push(o.reference+' : traitement en cours, reprise de synchronisation nécessaire');continue;}
    const hasLabel=(await db.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND (status='ready' OR result IS NOT NULL OR tracking<>'[]'::jsonb)",[o.id])).rows.length;
    // Save the external document snapshot, never set ERP jobs to pending or complete.
    await db.query('UPDATE orders SET erp_live=jsonb_set(erp_live,ARRAY[$2],$3::jsonb),erplain_refresh=erplain_refresh||$4::jsonb WHERE id=$1',[o.id,key,JSON.stringify({...o.erp_live[key],...document}),JSON.stringify({at:new Date().toISOString(),account:job.account,jobId:job.id})]);
    if(section==='orders'&&!hasLabel&&!o.partial_mode){const a=orderAddress(document.shipping_address,o.recipient);if(a.street&&a.country)await db.query('UPDATE orders SET address=$2,resolution_pending_resume=true WHERE id=$1',[o.id,JSON.stringify({...o.address,...a})]);}
    const issues=[];
    if(section==='orders'){
     const local=(await db.query('SELECT target_sku sku,target_quantity quantity FROM lines WHERE order_id=$1',[o.id])).rows;
     const sum=ls=>{const m=new Map();for(const l of ls){const sku=l.sku||l.variant?.sku;m.set(sku,(m.get(sku)||0)+Number(l.quantity));}return JSON.stringify([...m].sort());};
     if(!usesRecordedBc(o)&&sum(local)!==sum(shippingProductLines(document.line_items)))issues.push('BC Erplain modifié : produits ou quantités différents de V3');
     if(hasLabel&&!same(orderAddress(document.shipping_address,o.recipient),orderAddress({label:o.address.name,address_1:o.address.street,city:o.address.city,postal_code:o.address.postal,country:o.address.country,phone:o.address.phone},o.recipient)))issues.push('Adresse Erplain modifiée : étiquette existante à vérifier');
     if(!hasLabel&&!o.partial_mode&&!issues.length){try{assertFullOrderStock(document.line_items||[],{preserveInstalled:o.channel==='tender'});}catch(e){issues.push(e.message);}}
    }
    await db.query('UPDATE orders SET erplain_refresh=erplain_refresh||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({issues})]);
    if(issues.length)result.warnings.push(...issues.map(i=>o.reference+' : '+i));
    if(hasLabel)result.protected++;affected.push(o.id);
   }
   if(section==='deliveries')await db.query('UPDATE partial_deliveries SET bl=bl||$2::jsonb,updated_at=now() WHERE bl->>\'id\'=$1 AND status NOT IN (\'queued\',\'creating_bl\',\'publishing_bl\',\'creating_stock\',\'finalizing_bl\',\'creating_label\')',[String(document.id),JSON.stringify(document)]);
  }return affected;
 }
 async function projectSection(job,section,records,result,api){if(!project)return;
  await (async()=>{
   let ids=[];
   if(['products','weights'].includes(section)){const skus=await withShipmentLock(()=>applyProducts(job,section,records,result));if(skus?.length)ids=(await db.query('SELECT DISTINCT o.id FROM orders o JOIN lines l ON l.order_id=o.id LEFT JOIN mappings m ON m.channel=o.channel AND m.source_sku=l.source_sku WHERE coalesce(l.target_sku,m.target_sku,l.source_sku)=ANY($1::text[]) AND NOT o.archived',[skus])).rows.map(r=>r.id);}
   if(['orders','deliveries'].includes(section))ids=await withShipmentLock(()=>applyDocuments(job,section,records,result));
   if(section==='stocks'&&job.account==='live'){
    const candidates=(await db.query("SELECT DISTINCT o.* FROM orders o JOIN lines l ON l.order_id=o.id WHERE NOT o.archived AND NOT o.partial_mode AND coalesce(l.target_sku,l.source_sku)=ANY($1::text[]) AND o.erp_live->'bc'->>'id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id AND c.status NOT IN ('failed','superseded')) AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status IN ('pending','processing')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))",[records.map(v=>v.sku)])).rows;
    for(let i=0;i<candidates.length;i++){const o=candidates[i];await checkpoint(job,{section,phase:'Recontrôle du stock des commandes',done:i,total:candidates.length});let issues=[];try{const r=await api.request('query V3RefreshStockOrder($id:ID!){Order(id:$id){id line_items{quantity reserved_quantity available on_hand location{id} variant{id sku track_inventory}}}}',{id:String(o.erp_live.bc.id)});if(!r.Order?.line_items?.length)throw Error('API Erplain · Stock du BC non reçu');assertFullOrderStock(r.Order.line_items,{preserveInstalled:o.channel==='tender'});await db.query("UPDATE erp_live_jobs SET error=null,updated_at=now() WHERE order_id=$1 AND status='review' AND error ~* 'stock'",[o.id]);}catch(e){issues=[e.message];result.warnings.push(o.reference+' : '+e.message);}
     const previous=(o.erplain_refresh?.issues||[]).filter(t=>!/stock/i.test(t));await db.query('UPDATE orders SET erplain_refresh=erplain_refresh||$2::jsonb WHERE id=$1',[o.id,JSON.stringify({issues:[...previous,...issues],stockCheckedAt:new Date().toISOString()})]);ids.push(o.id);
    }
   }
   if(section==='stocks'&&job.account==='source')for(const v of records)await db.query('INSERT INTO stock_cache(variant_id,sku,label,on_hand,available,active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(variant_id) DO UPDATE SET sku=excluded.sku,label=excluded.label,on_hand=excluded.on_hand,available=excluded.available,active=excluded.active,updated_at=now()',[v.id,v.sku,v.label,v.on_hand,v.available,v.active]);
   if(ids.length)await withShipmentLock(async()=>{
    const safe=[];for(const id of ids){const active=(await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing')",[id])).rows.length;if(active)result.protected++;else safe.push(id);}
    const checked=await recheckOrders(db,safe);result.diagnostics=checked.length;for(const c of checked){if(c.problem)result.warnings.push(c.problem);
     const o=(await db.query('SELECT erplain_refresh FROM orders WHERE id=$1',[c.id])).rows[0],issues=o?.erplain_refresh?.issues||[];
     if(issues.length&&!c.protected){await db.query("UPDATE orders SET issue=$2,label_status='blocked',resolution_pending_resume=true WHERE id=$1",[c.id,issues.join(' ; ')]);}
     if(c.prepared&&['products','weights'].includes(section))await db.query("UPDATE erp_live_jobs SET error=null,updated_at=now() WHERE order_id=$1 AND status='review' AND error ~* '^(Poids|SKU Erplain|Produit Erplain|Référence Erplain)'",[c.id]);
     if(!c.protected){const error=c.problem||issues.join(' ; ')||null;await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,stage,payload,result,error) VALUES($1,$2,$1,'sync',$3,'Actualisation Erplain terminée',$4,$5,$6)",[randomUUID(),c.id,error?'review':'complete',JSON.stringify({account:job.account,section}),JSON.stringify({synchronization:job.id,preparationNotStarted:true}),error]);}
    }
   });
  })();
 }
 async function run(){if(running)return;running=true;let job;
  try{job=(await db.query("UPDATE erplain_refresh_jobs SET status='running',updated_at=now() WHERE id=(SELECT id FROM erplain_refresh_jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *")).rows[0];if(!job)return;
   if(job.payload.manualOrders||job.payload.sections.includes('orders'))throw Error('Ancienne récupération suspendue : utiliser le parcours ciblé Commandes Erplain');
   const api=apiFactory(job.account);await api.verify();const results=[];
   for(const section of job.payload.sections){try{
    const records=await readSection(api,job,section);await checkpoint(job,{section,phase:'Mise à jour locale',done:records.length,total:records.length});
    const result=await cache(job,section,records);await projectSection(job,section,records,result,api);results.push(result);
    await db.query('INSERT INTO erplain_refresh_sections(account,section,last_success,last_job,last_result) VALUES($1,$2,now(),$3,$4) ON CONFLICT(account,section) DO UPDATE SET last_success=now(),last_job=excluded.last_job,last_result=excluded.last_result',[job.account,section,job.id,JSON.stringify(result)]);
   }catch(e){const cancelled=(await db.query('SELECT cancel_requested FROM erplain_refresh_jobs WHERE id=$1',[job.id])).rows[0].cancel_requested;results.push({section,status:cancelled?'cancelled':'failed',error:e.message});await db.query('UPDATE erplain_refresh_jobs SET result=$2 WHERE id=$1',[job.id,JSON.stringify(results)]);if(cancelled)break;}
    await db.query('UPDATE erplain_refresh_jobs SET result=$2,updated_at=now() WHERE id=$1',[job.id,JSON.stringify(results)]);
   }
   const cancelled=(await db.query('SELECT cancel_requested FROM erplain_refresh_jobs WHERE id=$1',[job.id])).rows[0].cancel_requested;
   await db.query('UPDATE erplain_refresh_jobs SET status=$2,result=$3,updated_at=now() WHERE id=$1',[job.id,cancelled?'cancelled':results.some(r=>['failed','review'].includes(r.status))?'review':'complete',JSON.stringify(results)]);
  }catch(e){if(job)await db.query("UPDATE erplain_refresh_jobs SET status='review',error=$2,updated_at=now() WHERE id=$1",[job.id,e.message]);}finally{running=false;}
 }
 async function routes({p,url,req,res,user,body,json,permitted}){if(!p.startsWith('/api/erplain-refresh/'))return false;
  permitted(user,['admin','manager','operator']);
  const manualReview=manualReviewService(db,apiFactory('live'));
  const targeted=targetedOrderService(db,apiFactory('live'));
  if(p==='/api/erplain-refresh/targeted-lookup'&&req.method==='POST'){json(res,200,await targeted.lookup(await body(req)));return true;}
  if(p==='/api/erplain-refresh/targeted-reread'&&req.method==='POST'){json(res,200,await targeted.reread(await body(req)));return true;}
  if(p==='/api/erplain-refresh/recovered-orders'&&req.method==='GET'){json(res,200,await targeted.list({search:url.searchParams.get('search')||'',page:url.searchParams.get('page')}));return true;}
  if(p==='/api/erplain-refresh/manual-review'&&req.method==='GET'){json(res,200,await manualReview.list());return true;}
  if(p==='/api/erplain-refresh/manual-review/approve'&&req.method==='POST'){json(res,200,await manualReview.approve(await body(req),user));return true;}
  if(p==='/api/erplain-refresh/manual-review/reject'&&req.method==='POST'){json(res,200,await manualReview.reject(await body(req),user));return true;}
  if(p==='/api/erplain-refresh/manual-orders'&&req.method==='GET'){json(res,200,await listManualOrders(db,{account:url.searchParams.get('account')||'live',search:url.searchParams.get('search')||'',page:url.searchParams.get('page')}));return true;}
  if(p==='/api/erplain-refresh/status'&&req.method==='GET'){json(res,200,await status(url.searchParams.get('account')||'live'));return true;}
  if(p==='/api/erplain-refresh/diagnostics'&&req.method==='GET'){const ids=(url.searchParams.get('ids')||'').split(',').filter(Boolean).slice(0,200);json(res,200,{rows:(await db.query('SELECT id,reference,erplain_refresh FROM orders WHERE id=ANY($1::text[])',[ids])).rows});return true;}
  if(p==='/api/erplain-refresh/data'&&req.method==='GET'){json(res,200,await data(url.searchParams.get('account'),url.searchParams.get('section'),url.searchParams.get('search')||'',url.searchParams.get('page')));return true;}
  if(req.method==='POST'){const b=await body(req);if(p==='/api/erplain-refresh/start'){json(res,202,await start(b,user));return true;}if(p==='/api/erplain-refresh/cancel'){await db.query("UPDATE erplain_refresh_jobs SET cancel_requested=true WHERE id=$1 AND status IN ('queued','running')",[b.id]);json(res,200,{message:'Arrêt demandé après la lecture en cours'});return true;}}
  throw Error('Action d’actualisation inconnue');
 }
 return {start,status,data,run,routes,get running(){return running;}};
}
