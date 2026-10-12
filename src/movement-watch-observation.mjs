import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {temuApi} from './temu-api.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';
import {readTemuOrderDiagnostic} from './temu-order-diagnostic.mjs';
import {carrierState} from './status-policy.mjs';
const pre=new Set(['LAST-MILE MANIFEST','LABEL CREATED','SHIPMENT INFORMATION RECEIVED']);
const allowed=new Set(['bg.open.accesstoken.info.get','bg.order.list.v2.get','bg.order.amount.query','bg.order.detail.v2.get','bg.logistics.shipment.v2.get','bg.logistics.shipment.result.get','temu.track.trackinginfo.get']);
export function observationFingerprint(o){const p=o.source_payload||{};return createHash('sha256').update(JSON.stringify({id:o.id,reference:o.reference,mall:p.mallId,packages:p.selectedReimport?.preservedPackages,hold:p.selectedReimport,labels:o.label_status,tracking:o.tracking_status,suspension:o.suspension,archived:o.archived,pending:o.resolution_pending_resume,issue:o.issue})).digest('hex');}
export function observationApi(api,{timeoutMs=600000,shouldStop=()=>false}={}){const deadline=Date.now()+timeoutMs;let expired=false;const stopped=()=>Object.assign(Error('Lecture interrompue pour arrêt propre'),{code:'STOPPED'});return Object.freeze({async read(type,data){if(!allowed.has(type))throw Error('Lecture du suivi uniquement : opération interdite');if(shouldStop())throw stopped();const remaining=deadline-Date.now();if(expired||remaining<=0)throw Error('Délai de lecture dépassé');let timer,poll;try{return await Promise.race([api.read(type,data),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Délai de lecture dépassé'));},remaining);poll=setInterval(()=>{if(shouldStop())reject(stopped());},1000);})]);}finally{clearTimeout(timer);clearInterval(poll);}}});}
export function transportClients(directory,{factory=temuApi,shops=loadShopVault,shouldStop=()=>false,loadConfig=async()=>JSON.parse((await readFile(path.join(directory,'temu-production.json'),'utf8')).replace(/^\uFEFF/,''))}={}){
 const cache=new Map();
 const client=c=>{const raw=factory(c),secrets=[c.TEMU_APP_KEY,c.TEMU_APP_SECRET,c.TEMU_ACCESS_TOKEN].filter(Boolean);return {async read(type,data){try{return await raw.read(type,data);}catch(e){let message=String(e.message||'Lecture TEMU interrompue');for(const secret of secrets)message=message.replaceAll(secret,'[secret]');throw Object.assign(Error(message.slice(0,500)),{retryAfter:e.retryAfter});}}};};
 return {async forOrder(o){const deadline=Date.now()+600000,mall=String(o.source_payload?.mallId||'');if(!/^\d+$/.test(mall))throw Error('Boutique TEMU non identifiée');const cached=cache.get(mall);if(cached&&Date.now()-cached.at<300000)return cached.api;
 const config=await loadConfig(),country=String(o.address?.country||'').toUpperCase();let configs=[config],vaultLoaded=false;
 for(let i=0;i<configs.length;i++){if(shouldStop()||i>=20||Date.now()>=deadline)throw Error('Connexion aux boutiques interrompue : nouvelle lecture nécessaire');const c=configs[i];let identity;const api=observationApi(client(c),{timeoutMs:deadline-Date.now(),shouldStop});try{identity=await api.read('bg.open.accesstoken.info.get',{});}catch{/* Keep the error generic: never retain credential content. */}
 if(String(identity?.mallId)===mall){cache.set(mall,{api,at:Date.now()});return api;}
 const associated=identity?.associatedMallTokenList?.filter(m=>String(m.mallId)===mall&&m.accessToken)||[];
 if(associated.length===1){const candidate=observationApi(client({...c,TEMU_ACCESS_TOKEN:associated[0].accessToken}),{timeoutMs:Math.max(1,deadline-Date.now()),shouldStop}),verified=await candidate.read('bg.open.accesstoken.info.get',{});if(String(verified?.mallId)!==mall)throw Error('Identité de boutique associée incohérente');cache.set(mall,{api:candidate,at:Date.now()});return candidate;}
 if(!vaultLoaded){vaultLoaded=true;const entries=await shops(directory);configs.push(...entries.filter(m=>!country||String(m.country).toUpperCase()===country).map(m=>({...config,TEMU_APP_KEY:m.appKey,TEMU_APP_SECRET:m.appSecret,TEMU_ACCESS_TOKEN:m.accessToken})));}
 }
 throw Error('Accès TEMU non vérifié pour la boutique de cette commande');}};
}
export async function observeMovement(api,order){
 api=observationApi(api);const result={checkedAt:new Date().toISOString(),domain:'physical_parcel_tracking',writeAllowed:false,resumeAllowed:false,proof:null,reasonCode:null,detail:null};
 const known=order.source_payload?.selectedReimport?.preservedPackages||[];
 const d=await readTemuOrderDiagnostic(api,order.reference,{knownPackages:known,order});
 if(d.status===3||d.cancellationRequested)return {...result,reasonCode:d.status===3?'order_cancelled':'cancellation_requested',detail:d.status===3?'Commande annulée sur TEMU : rapprochement du suivi nécessaire, reprise conservée à l’arrêt.':'Annulation demandée chez TEMU : reprise conservée à l’arrêt.'};
 if(d.errors.length||!d.packages.length)return {...result,reasonCode:'read_incomplete',detail:'Suivi du colis non vérifiable (TEMU) : '+(d.errors.map(e=>e.message).join(' · ')||'aucun colis identifié'),proof:{sourceStatus:d.status,complete:false}};
 const parcels=[];
 for(const p of d.packages){const t=await api.read('temu.track.trackinginfo.get',{packageSn:p.packageSn});if(t?.packageSn!==p.packageSn||String(t.trackingNum)!==String(p.trackingNumber)||!Array.isArray(t.trackingInfo)||!t.trackingInfo.length)throw Error('Suivi du colis non vérifiable : identité ou événements manquants');
 const seen=new Set(),events=t.trackingInfo.map(e=>{const raw=String(e.logisticsUpdatedAt||''),at=/^\d{10,13}$/.test(raw)?new Date(Number(raw)*(raw.length===10?1000:1)).toISOString():raw;if(!Number.isFinite(Date.parse(at))||Date.parse(at)>Date.now()+300000)throw Error('Suivi du colis non vérifiable : date invalide');const row={code:String(e.logisticsStatus||''),label:String(e.statusText||'').slice(0,300),at};const key=JSON.stringify(row);if(seen.has(key))throw Error('Suivi du colis non vérifiable : événements dupliqués');seen.add(key);return row;});
 const states=events.map(e=>carrierState('temu',e)),contradiction=events.some(e=>pre.has(e.code.toUpperCase())&&['shipped','delivered','cancelled','exception'].includes(carrierState('temu',{label:e.label})));
 const preparationOnly=!contradiction&&events.every((e,i)=>pre.has(e.code.toUpperCase())&&states[i]==='not_shipped');
 parcels.push({packageSn:p.packageSn,tracking:String(p.trackingNumber),carrier:String(p.shippingCompanyName||''),labelStatus:Number(p.shippingLabelStatus),preparationOnly,states,events});
 }
 const proof={sourceStatus:d.status,complete:true,parcels,originalTrackingGuardPasses:parcels.every(p=>p.preparationOnly),universalNoMovementCertificate:false};
 if(proof.originalTrackingGuardPasses)return {...result,reasonCode:'preparation_only_observed',detail:'Suivi TEMU relu : seuls des événements de préparation sont observés. Reprise historique et autres contrôles à valider. Suspension conservée.',proof};
 const physical=parcels.some(p=>p.states.some(s=>['shipped','delivered'].includes(s)));
 return {...result,reasonCode:physical?'physical_progress':'tracking_review',detail:physical?'Colis TEMU pris en charge ou livré : suivi uniquement, aucune nouvelle préparation déduite.':'Suivi du colis non vérifiable (TEMU) : événement inconnu, contradictoire ou incident à rapprocher.',proof};
}
