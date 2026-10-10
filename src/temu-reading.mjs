import {attachReportTracking} from './temu-reading-reports.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {relayConfig} from './temu-read-relay.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {erplainAccount} from './erplain-accounts.mjs';
import {readV2Parcels} from './v2-tracking-read.mjs';
import {window28,sourceRow,processKind,listReading} from './temu-reading-core.mjs';

// This module never writes to orders, jobs, marketplace receipts or Erplain.
// Only this separate observation file is persisted. All external calls are reads.
export async function collectReading({db,directory,save,now=new Date(),factory=temuApi,shops=loadShopVault,erp=erplainAccount(directory,'source'),relay=relayConfig()}){
 if(relay?.host!=='135.125.79.68')throw Error('Lecture TEMU : relais V2 obligatoire indisponible');
 const d={...window28(now),phase:'Connexion aux boutiques',progress:0,coverage:[],errors:[],rows:[],running:true,startedAt:now.toISOString()};
 const checkpoint=async()=>{d.updatedAt=new Date().toISOString();await save(d);};await checkpoint();
 const config=JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,'')),clients=new Map();
 const knownCountries=(await db.query("SELECT DISTINCT source_payload->>'mallId' mall,address->>'country' country FROM orders WHERE channel='temu' AND address->>'country' IS NOT NULL")).rows;
 const knownCountry=mall=>{const values=[...new Set(knownCountries.filter(r=>r.mall===String(mall)&&/^[A-Z]{2}$/.test(r.country)).map(r=>r.country))];return values.length===1?values[0]:null;};
 async function register(c,country){try{const api=factory(c),i=await api.read('bg.open.accesstoken.info.get',{});if(!i.mallId)throw Error('Identité boutique absente');
 clients.set(String(i.mallId),{api,country:country||config.TEMU_COUNTRIES?.[i.mallId]||knownCountry(i.mallId)||'Pays non communiqué'});
 for(const m of i.associatedMallTokenList||[])if(m.mallId&&m.accessToken&&!clients.has(String(m.mallId)))clients.set(String(m.mallId),{api:factory({...c,TEMU_ACCESS_TOKEN:m.accessToken}),country:config.TEMU_COUNTRIES?.[m.mallId]||knownCountry(m.mallId)||'Pays non communiqué'});
 }catch{d.errors.push('Connexion boutique '+(country||'principale')+' indisponible');}}
 await register(config,'');for(const m of await shops(directory))await register({...config,TEMU_APP_KEY:m.appKey,TEMU_APP_SECRET:m.appSecret,TEMU_ACCESS_TOKEN:m.accessToken},m.country);
 for(const c of clients.values())if(c.country==='Pays non communiqué')d.errors.push('Pays non communiqué pour une boutique TEMU');
 const rows=new Map();let shopDone=0;
 for(const [mall,c]of clients){const cover={mall,country:c.country,complete:false,pages:0,included:0};d.coverage.push(cover);
 try{let seen=new Set();for(let page=1;page<=2000;page++){
 d.phase='Commandes · '+c.country+' · page '+page;
 const r=await c.api.read('bg.order.list.v2.get',{pageNumber:page,pageSize:50,updateAtStart:Math.floor(Date.parse(d.start)/1000),updateAtEnd:Math.floor(Date.parse(d.end)/1000),sortby:'updateTime'});
 if(!Array.isArray(r.pageItems)||!Number.isFinite(Number(r.totalItemNum)))throw Error('Pagination TEMU non vérifiable');
 let added=0;for(const entry of r.pageItems){const ref=entry.parentOrderMap?.parentOrderSn;if(ref&&!seen.has(ref)){seen.add(ref);added++;}const row=sourceRow(entry,mall,c.country,d);if(row)rows.set(mall+':'+row.reference,row);}
 cover.pages=page;cover.included=[...rows.values()].filter(x=>x.mall===mall).length;d.rows=[...rows.values()];await checkpoint();
 if(page*50>=Number(r.totalItemNum)){cover.complete=true;break;}
 if(!added||page===2000)throw Error('Pagination TEMU interrompue');
 }}catch(e){cover.error=String(e.message).slice(0,300);}
 d.progress=Math.round(++shopDone/Math.max(1,clients.size)*20);await checkpoint();}
 d.rows=[...rows.values()];
 // Read only: absence of a BC in V3 is not absence in Erplain.
 const local=(await db.query("SELECT id,reference,source_reference,archived,source_payload,erp_live FROM orders WHERE channel='temu'")).rows;
 for(const r of d.rows){const matches=local.filter(o=>o.reference===r.reference||o.source_reference===r.reference);r.presentV3=matches.length>0;r.archivedV3=matches.some(o=>o.archived);r.process=processKind(matches);}
 async function documents(kind,group){let found=[];for(let page=1;page<=1000;page++){
 const q=kind==='Orders'?'id label status external_reference shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}':'id label status external_reference';
 const type=kind==='Orders'?'QueryOrdersWhereWhereConditions':'QueryShippingOrdersWhereWhereConditions';
 const x=await erp.request(`query TemuReading($where:${type},$page:Int!){${kind}(first:100,page:$page,where:$where){data{${q}} paginatorInfo{hasMorePages}}}`,{page,where:{OR:group.map(r=>({column:'EXTERNAL_REFERENCE',operator:'EQ',value:r.reference}))}});
 if(!Array.isArray(x[kind]?.data)||typeof x[kind]?.paginatorInfo?.hasMorePages!=='boolean')throw Error('Réponse Erplain incomplète');found.push(...x[kind].data);if(!x[kind].paginatorInfo.hasMorePages)return found;
 }throw Error('Pagination Erplain interrompue');}
 for(let i=0;i<d.rows.length;i+=25){const group=d.rows.slice(i,i+25);d.phase='Rapprochement Erplain';
 try{const bc=await documents('Orders',group),bl=await documents('ShippingOrders',group);
 for(const r of group){r.bc=bc.filter(b=>b.external_reference===r.reference);r.bl=[...new Map([...r.bc.flatMap(b=>b.shipping_orders?.data||[]),...bl.filter(b=>b.external_reference===r.reference)].map(b=>[String(b.id),b])).values()];r.erpCheckedAt=new Date().toISOString();if(r.bc.some(b=>b.shipping_orders?.paginatorInfo?.hasMorePages))r.errors.push('Liste BL liée incomplète');}
 }catch(e){for(const r of group)r.errors.push('Lecture Erplain : '+String(e.message).slice(0,300));}
 d.progress=20+Math.round(Math.min(i+25,d.rows.length)/Math.max(1,d.rows.length)*20);await checkpoint();}
 for(let i=0;i<d.rows.length;i++){const r=d.rows[i];d.phase='Suivi TEMU · '+(i+1)+' / '+d.rows.length;
 try{const api=clients.get(r.mall).api,detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:r.reference});if(detail.parentOrderMap?.parentOrderSn!==r.reference)throw Error('Identité commande incohérente');r.temuOrderStatus=detail.parentOrderMap.parentOrderStatus;
 const result=await readV2Parcels(api.read,{reference:r.reference,tracking:[]},detail,r.mall);r.parcels=result.parcels;r.events=result.events;r.errors.push(...result.errors);r.temuCheckedAt=new Date().toISOString();
 }catch(e){r.errors.push('Lecture suivi : '+String(e.message).slice(0,300));}
 d.progress=40+Math.round((i+1)/Math.max(1,d.rows.length)*60);await checkpoint();}
 d.phase='Lecture terminée';d.progress=100;d.running=false;d.completedAt=new Date().toISOString();d.complete=clients.size>0&&!d.errors.length&&d.coverage.every(c=>c.complete)&&d.rows.every(r=>!r.errors.length);await checkpoint();return d;
}

export async function repairReadingTracking(snapshot,{directory,save,factory=temuApi,shops=loadShopVault}){
 const d=structuredClone(snapshot);d.trackingRepairVersion=1;d.running=true;d.phase='Actualisation du suivi TEMU';d.progress=0;delete d.completedAt;
 const persist=async()=>{d.updatedAt=new Date().toISOString();await save(d);};await persist();
 try{
 if(relayConfig()?.host!=='135.125.79.68')throw Error('Lecture TEMU : relais V2 obligatoire indisponible');
 const config=JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,'')),clients=new Map();
 for(const c of [config,...(await shops(directory)).map(m=>({...config,TEMU_APP_KEY:m.appKey,TEMU_APP_SECRET:m.appSecret,TEMU_ACCESS_TOKEN:m.accessToken}))]){
 try{const api=factory(c),identity=await api.read('bg.open.accesstoken.info.get',{});if(identity.mallId)clients.set(String(identity.mallId),api);for(const m of identity.associatedMallTokenList||[])if(m.mallId&&m.accessToken)clients.set(String(m.mallId),factory({...c,TEMU_ACCESS_TOKEN:m.accessToken}));}catch{/* A missing shop becomes an explicit row error below. */}}
 const targets=d.rows.filter(r=>(r.errors||[]).some(e=>e.includes('numéro de suivi non disponible')));
 for(let i=0;i<targets.length;i++){const r=targets[i];d.phase='Actualisation du suivi TEMU · '+(i+1)+' / '+targets.length;
 try{const api=clients.get(String(r.mall));if(!api)throw Error('Boutique TEMU indisponible');const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:r.reference});if(detail.parentOrderMap?.parentOrderSn!==r.reference)throw Error('Identité commande incohérente');const result=await readV2Parcels(api.read,{reference:r.reference,tracking:[]},detail,r.mall);r.parcels=result.parcels;r.events=result.events;r.errors=(r.errors||[]).filter(e=>!e.startsWith('Lecture suivi : '));r.errors.push(...result.errors);r.temuOrderStatus=detail.parentOrderMap.parentOrderStatus;r.temuCheckedAt=new Date().toISOString();}
 catch(e){r.errors=(r.errors||[]).filter(e=>!e.startsWith('Lecture suivi : '));r.errors.push('Lecture suivi : '+String(e.message).slice(0,300));}
 d.progress=Math.round((i+1)/Math.max(1,targets.length)*100);await persist();}
 d.phase='Actualisation du suivi TEMU terminée';d.progress=100;
 }catch(e){d.phase='Actualisation du suivi TEMU interrompue';d.errors.push(String(e.message).slice(0,300));}
 d.running=false;d.completedAt=new Date().toISOString();d.complete=!d.errors.length&&d.coverage.every(c=>c.complete)&&d.rows.every(r=>!r.errors.length);await persist();return d;
}

export function readingService(db,directory,{collect=collectReading}={}){
 const file=path.join(directory,'temu-reading-observation.json');let active=null,current=null;
 async function read(){if(current)return current;try{const s=JSON.parse(await readFile(file,'utf8'));if(s.running){s.running=false;s.phase='Lecture interrompue · relancer';}return s;}catch(e){if(e.code!=='ENOENT')throw e;return {rows:[],coverage:[],errors:[],phase:'Aucune lecture effectuée',progress:0,running:false};}}
 async function save(d){current=structuredClone(d);await writeFile(file+'.tmp',JSON.stringify(d),{mode:0o600});await rename(file+'.tmp',file);}
 return {async routes(req,res,url,user,json){if(!url.pathname.startsWith('/api/temu-reading'))return false;
 if(url.pathname==='/api/temu-reading'&&req.method==='GET'){const previous=await read();if(!active&&!previous.trackingRepairVersion&&(previous.rows||[]).some(r=>(r.errors||[]).some(e=>e.includes('numéro de suivi non disponible')))){current={...previous,running:true,phase:'Actualisation du suivi TEMU',progress:0};active=repairReadingTracking(previous,{directory,save}).finally(()=>{active=null;});}const snapshot=await read();let report;try{report=JSON.parse(await readFile(new URL('./temu-reading-reports.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;report={};}json(res,200,listReading(attachReportTracking(snapshot,report),url.searchParams));return true;}
 if(url.pathname==='/api/temu-reading/refresh'&&req.method==='POST'){
 if(!['admin','manager','operator'].includes(user.role)){json(res,403,{error:'Actualisation réservée aux opérateurs'});return true;}
 if(!active){current={rows:[],coverage:[],errors:[],phase:'Démarrage de la lecture',running:true,progress:0};active=collect({db,directory,save}).catch(async e=>{const d=await read();d.running=false;d.phase='Lecture échouée';d.errors.push(String(e.message).slice(0,300));await save(d);}).finally(()=>{active=null;});}
 json(res,202,{running:true});return true;}
 json(res,405,{error:'Action indisponible dans cet onglet de consultation'});return true;}};
}
