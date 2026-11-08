import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {openDatabase} from '../src/db.mjs';
import {loadTemuShopConfig} from '../src/temu-shop-clients.mjs';
import {temuApi} from '../src/temu-api.mjs';
import {offerParcel} from '../src/temu-shipping.mjs';

const mall='670702094848591',warehouse='WH-07213277470860591',morcourt='WH-03738368983180591';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const carrierName=p=>String(p.shippingCompanyName||p.carrier||'');
export function chooseCorrectionOffer(raw,parcel,{signature=false,deadline=Date.now()+86400000}={}){
 const base={warehouseId:warehouse,weight:parcel.weight,weightUnit:parcel.weightUnit,length:parcel.length,width:parcel.width,height:parcel.height,dimensionUnit:parcel.dimensionUnit};
 const info={lines:parcel.orderSendInfoList,signature,deadline};
 const valid=(raw.onlineChannelDtoList||[]).flatMap(offer=>{
  try{return [{...offer,...offerParcel(offer,base,info)}];}catch{return [];}
 }).filter(o=>o.currency==='EUR');
 return valid.filter(o=>/\bGOFO\b/i.test(carrierName(o))).sort((a,b)=>a.amount-b.amount)[0]
  ||valid.find(o=>o.channelId===parcel.channelId&&o.shipCompanyId===parcel.shipCompanyId)
  ||null;
}
export function assertCorrectionParcel(parcel,reference){
 if(!parcel||parcel.shippingLabelStatus!==1||!parcel.isConfirmAfterPickup||!parcel.trackingNumber
  ||![warehouse,morcourt].includes(parcel.warehouseId)||!/^PK-\d+$/.test(parcel.packageSn||'')
  ||!parcel.orderSendInfoList?.length||parcel.orderSendInfoList.some(l=>l.parentOrderSn!==reference)
  ||parcel.subPackageSnList?.length||!/(colissimo|chronopost)/i.test(carrierName(parcel)))throw Error('Colis hors périmètre Colissimo/Chronopost non expédié');
}

// Explicit manifest, direct authorized API access, one mutation per parcel. Never retry a purchase.
export async function correctPaidLabels({references,directory,auditDirectory,apply=false,log=console.log}){
 if(!Array.isArray(references)||!references.length||references.some(r=>!/^PO-\d+(?:-\d+)+$/.test(r))||new Set(references).size!==references.length)throw Error('Liste de références explicite et unique requise');
 await mkdir(auditDirectory,{recursive:true,mode:0o700});
 const config=await loadTemuShopConfig(directory),api=temuApi(config,{relay:null});
 const identity=await api.read('bg.open.accesstoken.info.get',{});
 if(String(identity.mallId)!==mall||!identity.apiScopeList?.includes('bg.logistics.shipment.update'))throw Error('Boutique France ou autorisation update absente');
 const db=await openDatabase({url:process.env.DATABASE_URL}),results=[];
 try{for(const reference of references){
  const folder=path.join(auditDirectory,reference);await mkdir(folder,{recursive:true,mode:0o700});
  const json=async(name,value,options={})=>writeFile(path.join(folder,name+'.json'),JSON.stringify(value,null,2),{mode:0o600,...options});
  try{const outcome=await db.withLocks(['stock-mutations'],async()=>{
   const o=(await db.query('SELECT * FROM orders WHERE reference=$1',[reference])).rows[0];
   if(!o||o.archived||o.tracking_status!=='not_shipped'||o.partial_mode||o.transport_choice||o.source_payload?.mallId?.toString()!==mall||Date.parse(o.source_date)<Date.parse('2026-11-06T08:00:00Z'))throw Error('Commande hors périmètre France/date/non expédiée');
   const job=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
   if(job?.status!=='complete'||job.packages?.length!==1)throw Error('Étiquette payée unique complète requise');
   const packageSn=job.packages[0];
   const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:reference}),parent=detail.parentOrderMap;
   if(parent?.parentOrderSn!==reference||Number(parent.parentOrderStatus)!==2)throw Error('Commande TEMU plus en attente expédition');
   if((parent.parentOrderLabel||[]).some(l=>['pending_buyer_cancellation','pending_buyer_address_change','pending_risk_control_alert'].includes(l.name)&&Number(l.value)===1))throw Error('Demande ou alerte TEMU à traiter');
   const before=await api.read('bg.logistics.shipment.result.get',{packageSnList:[packageSn]});
   const p=before.packageInfoResultList?.[0];
   if(before.packageInfoResultList?.length!==1||p.packageSn!==packageSn)throw Error('Résultat colis incomplet');
   // Completed records are verified on resume; no second carrier purchase.
   let completed;try{completed=JSON.parse(await readFile(path.join(folder,'completed.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(completed){if(p.trackingNumber!==completed.tracking||p.warehouseId!==warehouse)throw Error('Résultat terminé a changé');return {...completed,status:'already_complete'};}
   assertCorrectionParcel(p,reference);
   const raw=await api.read('bg.logistics.shippingservices.get',{warehouseId:warehouse,weight:p.weight,weightUnit:p.weightUnit,length:p.length,width:p.width,height:p.height,dimensionUnit:p.dimensionUnit,shipOrderInfoList:p.orderSendInfoList,signatureOnDelivery:!!p.signServiceId});
   const chosen=chooseCorrectionOffer(raw,p,{signature:!!p.signServiceId,deadline:Number(parent.expectShipLatestTime)*1000});
   if(!chosen)throw Error('GOFO et transporteur actuel indisponibles depuis Rozay');
   const proposal={reference,packageSn,previousWarehouse:p.warehouseName,previousCarrier:carrierName(p),previousTracking:p.trackingNumber,previousAmount:p.estimatedAmount,warehouseId:warehouse,carrier:carrierName(chosen),channelId:chosen.channelId,shipCompanyId:chosen.shipCompanyId,amount:chosen.amount,currency:chosen.currency};
   await json('proposal',proposal);
   if(!apply)return {...proposal,status:'preview'};
   if(chosen.channelId===p.channelId&&p.warehouseId===warehouse)return {...proposal,status:'unchanged'};
   const docs=(await db.query('SELECT reference,package,pdf FROM temu_label_documents WHERE package=$1',[packageSn])).rows;
   if(docs.length!==1||docs[0].reference!==reference||!docs[0].pdf?.length)throw Error('Archive étiquette absente ou partagée');
   const original=docs[0].pdf;
   if((await db.query("SELECT 1 FROM label_sku_copies WHERE order_id=$1 AND document_key LIKE 'preserved:%' LIMIT 1",[o.id])).rows.length)throw Error('Copie SKU préservée à rapprocher avant modification');
   await json('before',{order:o,job,before,proposal});
   await writeFile(path.join(folder,'original.pdf'),original,{mode:0o600,flag:'wx'});
   const parcel={...chosen.parcel,packageSn,confirmAcceptance:['SUCCESSFUL_RETRY']};
   const request={retrySendPackageRequestList:[parcel]};
   await json('attempt',{at:new Date().toISOString(),request},{flag:'wx'});
   const payload={app_key:config.TEMU_APP_KEY,access_token:config.TEMU_ACCESS_TOKEN,data_type:'JSON',timestamp:String(Math.floor(Date.now()/1000)),type:'bg.logistics.shipment.update',...request};
   const assembled=Object.keys(payload).sort().map(k=>k+(typeof payload[k]==='object'?JSON.stringify(payload[k]):String(payload[k]))).join('');
   const sign=createHash('md5').update(config.TEMU_APP_SECRET+assembled+config.TEMU_APP_SECRET).digest('hex').toUpperCase();
   const http=await fetch('https://openapi-b-eu.temu.com/openapi/router',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,sign})});
   const response=await http.json();await json('response',response);
   if(!http.ok||response.success!==true||response.result!==true)throw Error('Modification refusée ou incertaine : '+String(response.errorCode)+' '+String(response.errorMsg||''));
   let observed,next;
   for(let attempt=0;attempt<12;attempt++){
    try{observed=await api.read('bg.logistics.shipment.result.get',{packageSnList:[packageSn]});next=observed.packageInfoResultList?.[0];
     if(next?.shippingLabelStatus===1&&next.warehouseId===warehouse&&next.channelId===chosen.channelId&&next.shipCompanyId===chosen.shipCompanyId&&next.trackingNumber&&next.isConfirmAfterPickup)break;
    }catch(e){await json('last-read-error',{error:e.message});}next=null;await sleep(2000);
   }
   if(!next)throw Error('Modification acceptée, résultat encore incertain : rapprochement requis sans nouvel achat');
   const document=await api.read('bg.logistics.shipment.document.get',{documentType:'SHIPPING_LABEL_PDF',packageSnList:[packageSn]});
   if(document.shippingLabelUrlList?.length!==1||document.shippingLabelUrlList[0].packageSn!==packageSn)throw Error('Nouveau PDF absent');
   const pdf=await api.pdf(document.shippingLabelUrlList[0].url);
   if(pdf.subarray(0,5).toString()!=='%PDF-'||(await PDFDocument.load(pdf)).getPageCount()<1||digest(pdf)===digest(original))throw Error('Nouveau PDF invalide ou identique à l’ancien');
   await writeFile(path.join(folder,'new.pdf'),pdf,{mode:0o600});await json('after',observed);
   const proof={...proposal,at:new Date().toISOString(),tracking:next.trackingNumber,warehouseName:next.warehouseName,pdfSha256:digest(pdf),previousPdfSha256:digest(original),requestId:response.requestId};
   await db.withLocks(['temu-pdf:'+packageSn],()=>db.transaction(async tx=>{
    const current=(await tx.query('SELECT * FROM temu_label_jobs WHERE reference=$1 FOR UPDATE',[reference])).rows[0];
    const saved=(await tx.query('SELECT pdf FROM temu_label_documents WHERE reference=$1 AND package=$2 FOR UPDATE',[reference,packageSn])).rows[0];
    if(digest(saved.pdf)!==digest(original))throw Error('Archive changée entretemps, conserver et rapprocher');
    const plan=current.plan?{...current.plan,request:{...current.plan.request,sendRequestList:current.plan.request.sendRequestList.map(x=>({...x,...chosen.parcel}))},warehouseCorrection:proof}:null;
    const result={...current.result,...observed,source:'temu_direct',observedAt:proof.at,packageInfoResultList:observed.packageInfoResultList.map(x=>({...x,carrier:x.shippingCompanyName,amount:x.estimatedAmount,currency:x.estimatedCurrencyCode,costEstimated:true})),deliveryStatuses:[],trackingErrors:[],trackingVerifiedAt:null,warehouseCorrection:proof};
    await tx.query('UPDATE temu_label_documents SET pdf=$3 WHERE reference=$1 AND package=$2',[reference,packageSn,pdf]);
    await tx.query("UPDATE temu_label_jobs SET status='complete',error=null,plan=$2::jsonb,result=$3::jsonb,updated_at=now() WHERE reference=$1",[reference,JSON.stringify(plan),JSON.stringify(result)]);
    await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','temu.paid_label_carrier_warehouse_corrected',$1::jsonb)",[JSON.stringify(proof)]);
   }));
   await json('completed',proof);return {...proof,status:'complete'};
  });results.push(outcome);log(JSON.stringify(outcome));}
  catch(e){const failure={reference,status:'review',error:e.message};await json('error',failure);results.push(failure);log(JSON.stringify(failure));
   // Any failed mutation must be reconciled before continuing with other purchases.
   try{await readFile(path.join(folder,'attempt.json'));break;}catch{}
  }
  await writeFile(path.join(auditDirectory,'summary.json'),JSON.stringify(results,null,2),{mode:0o600});
 }}finally{await writeFile(path.join(auditDirectory,'summary.json'),JSON.stringify(results,null,2),{mode:0o600});await db.close();}
 return results;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),manifest=args.find(a=>!a.startsWith('--'));
 if(!manifest)throw Error('Usage: node scripts/temu-paid-label-correction.mjs manifest.json [--apply]');
 const data=JSON.parse(await readFile(manifest,'utf8'));
 const results=await correctPaidLabels({...data,directory:process.env.DATA_DIR,apply:args.includes('--apply')});
 if(results.some(r=>r.status==='review'))process.exitCode=1;
}
