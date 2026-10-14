import {recoverMissingTemuPdfs} from './temu-pdf-archive.mjs';
import {usesRecordedBc} from './existing-bc-execution.mjs';
import {hasCreatedBl} from './created-bl-label.mjs';
import {retiredCommercialControl} from './post-bc-control-recovery.mjs';
import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';
import {completedExcelPreparation} from './temu-excel-purchase-admission.mjs';
import {isTemuExcel,verifiedExcelCommercial} from './temu-excel-commercial.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {hasExternalLabel} from './temu-external-label.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {excludedTemuCarrier} from './temu-purchase-policy.mjs';
import {randomUUID,createHash} from 'node:crypto';
export async function initializeTemuShipping(db){await db.exec(`CREATE TABLE IF NOT EXISTS temu_label_jobs(reference TEXT PRIMARY KEY,status TEXT NOT NULL,plan JSONB,attempt_id TEXT,packages JSONB NOT NULL DEFAULT '[]',result JSONB,error TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS temu_label_documents(reference TEXT REFERENCES temu_label_jobs(reference) ON DELETE CASCADE,package TEXT,pdf BYTEA,PRIMARY KEY(reference,package));`);if(db.recoverInterrupted!==false)await db.query("UPDATE temu_label_jobs SET status='uncertain',error='Achat interrompu : récupération obligatoire, aucun nouvel achat automatique' WHERE status='purchasing'");}
export function canonicalTemuValue(value){if(Array.isArray(value))return value.map(canonicalTemuValue);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalTemuValue(value[key])]));return value;}
export const hash=v=>createHash('sha256').update(JSON.stringify(canonicalTemuValue(v))).digest('hex');
export async function readTemuShipments(api,reference,detail){
 if(detail?.parentOrderMap?.parentOrderSn!==reference||!detail.orderList?.length)throw Error('TEMU · Articles absents pour lire les expéditions');
 const orderSns=[...new Set(detail.orderList.map(l=>l.orderSn))];
 if(orderSns.some(s=>typeof s!=='string'||!s))throw Error('TEMU · Référence de ligne absente');
 const shipmentInfoDTO=[];
 for(const orderSn of orderSns){const r=await api.read('bg.logistics.shipment.v2.get',{parentOrderSn:reference,orderSn});if(!Array.isArray(r.shipmentInfoDTO))throw Error('TEMU · Réponse des expéditions incomplète');shipmentInfoDTO.push(...r.shipmentInfoDTO);}
 return {shipmentInfoDTO};
}
const names=v=>(v||[]).filter(x=>typeof x==='string'||x?.value===1||x?.value==='1'||x?.value===true).map(x=>typeof x==='string'?x:x.name);
export function inspectTemu(detail,reference){
 const p=detail.parentOrderMap,items=detail.orderList;if(p?.parentOrderSn!==reference||!Array.isArray(items)||!items.length)throw new Error('Identité ou articles TEMU incomplets');
 if(Number(p.parentOrderStatus)===3)throw new Error('Commande TEMU annulée : aucun nouvel achat');
 const flags=[...names(p.parentOrderLabel),...items.flatMap(i=>names(i.orderLabel))];
 // Platform risk/address/cancellation labels remain indicative; actual data and provider responses are checked below.
 if([p,...items].some(x=>String(x.orderPaymentType).toUpperCase()==='COD'))throw new Error('Paiement à la livraison incompatible');
 const packages=[...new Set(items.flatMap(i=>(i.packageSnInfo||[]).map(x=>x.packageSn)))];if(packages.some(x=>!/^PK-\d+$/.test(x)))throw new Error('Colis TEMU invalide');
 const lines=items.map(i=>({parentOrderSn:reference,orderSn:String(i.orderSn||''),quantity:Number(i.quantity)}));
 if(lines.some(l=>!l.orderSn||!Number.isInteger(l.quantity)||l.quantity<=0)||new Set(lines.map(l=>l.orderSn)).size!==lines.length)throw new Error('Articles ou quantités TEMU invalides');
 const pres=items.map(i=>names(i.orderLabel).includes('Y2_advance_sale'));if(pres.some(Boolean)&&!pres.every(Boolean))throw new Error('Précommandes et commandes ordinaires à séparer');
 return {lines,packages,signature:flags.includes('signature_required_on_delivery'),hours:pres.some(Boolean)?360:120,status:Number(p.parentOrderStatus),fingerprint:hash({reference,lines,packages,signature:flags.includes('signature_required_on_delivery'),hours:pres.some(Boolean)?360:120,payment:[p,...items].map(x=>x.orderPaymentType),deadline:p.expectShipLatestTime}),deadline:Number(p.expectShipLatestTime)*1000};
}
export function offerParcel(offer,base,info,now=Date.now()){
 if(excludedTemuCarrier(offer))throw new Error('Cainiao exclu : choisir un autre transporteur TEMU');
 const currency=offer.estimatedCurrencyCode;const symbol=({EUR:'€',GBP:'£',USD:'$'})[currency];let price=String(offer.estimatedAmount??'').trim();if(symbol)price=price.replace(symbol,'');if(/^[A-Z]{3}$/.test(currency||''))price=price.replace(currency,'');price=price.trim();const amount=/^\d+(?:[.,]\d{1,2})?$/.test(price)?Number(price.replace(',','.')):NaN;if(!String(offer.estimatedAmount||'').trim()||!Number.isFinite(amount)||amount<0||! /^[A-Z]{3}$/.test(offer.estimatedCurrencyCode||''))throw new Error('Prix ou devise non vérifiable');
 if(offer.unavailableReason)throw new Error(String(offer.unavailableReason).slice(0,250));
 if(!Number.isSafeInteger(offer.channelId)||offer.channelId<=0||!Number.isSafeInteger(offer.shipCompanyId)||offer.shipCompanyId<=0||offer.unavailableReason||offer.supportInterlineShipping)throw new Error('Service incompatible');
 if(info.signature&&!offer.signServiceId)throw new Error('Signature obligatoire absente');
 if((offer.infoNeeded||[]).some(k=>!['pickupStartTime','pickupEndTime'].includes(k)))throw new Error('Informations supplémentaires requises');
 let pickup={};const slots=offer.availablePickupTimeSlotList||[];
 if(slots.length||(offer.infoNeeded||[]).length){const valid=slots.filter(s=>Number.isSafeInteger(s.pickupStartTime)&&Number.isSafeInteger(s.pickupEndTime)&&s.pickupStartTime*1000>now&&s.pickupEndTime>s.pickupStartTime&&s.pickupEndTime*1000<=info.deadline).sort((a,b)=>a.pickupStartTime-b.pickupStartTime);if(!valid.length)throw new Error('Créneau d’enlèvement valide absent');pickup=valid.at(-1);}
 return {amount,currency:offer.estimatedCurrencyCode,parcel:{...base,orderSendInfoList:info.lines,shipCompanyId:offer.shipCompanyId,channelId:offer.channelId,...(offer.signServiceId?{signServiceId:offer.signServiceId}:{}),...pickup,autoConfirmAfterPickup:true}};
}
function excelShipmentProof(order,lines){
 const recorded=usesRecordedBc(order),state=order.erp_live;
 return {order:{id:order.id,address:order.address,erp_live:recorded?{bc:{id:state.bc.id,status:state.bc.status},bl:state.bl?{id:state.bl.id,label:state.bl.label,status:state.bl.status}:null,stockDocument:state.stockDocument?{id:state.stockDocument.id,status:state.stockDocument.status,update_stock:state.stockDocument.update_stock}:null}:state,suspension:order.suspension,issue:recorded&&retiredCommercialControl(order.issue)?null:order.issue,archived:order.archived,label_status:order.label_status,tracking_status:order.tracking_status,resolution_pending_resume:order.resolution_pending_resume,transport_choice:order.transport_choice,partial_mode:order.partial_mode,weight_kg:order.weight_kg,source_payload:{...(!recorded?{temuExcelCommercial:order.source_payload.temuExcelCommercial,marketplacePendingCorrection:order.source_payload.marketplacePendingCorrection}:{}),temuExcelPreparation:order.source_payload.temuExcelPreparation,mallId:order.source_payload.mallId}},...(!recorded?{lines}:{})};
}
function recordedBcQuoteId(plan){
 const request={...plan.request,sendRequestList:plan.request.sendRequestList.map(parcel=>({...parcel,orderSendInfoList:parcel.orderSendInfoList.map(({quantity,...identity})=>identity)}))};
 return hash({request,amount:plan.amount,currency:plan.currency,preparationFingerprint:plan.preparationFingerprint??null,...(plan.blAuthority?{blAuthority:plan.blAuthority}:{})});
}

function assertExistingBlLabelOrder(order){
 const blocked=suspensionBlock(order);if(blocked)throw Error(blocked);
 if(order.archived||order.simulation||order.label_status==='cancelled'||['cancelled','shipped','in_transit','delivered'].includes(order.tracking_status))throw Error('Commande annulée, expédiée ou hors production : aucun nouvel achat');
 if(order.partial_mode)throw Error('Utiliser le BL et les quantités de la livraison partielle');
 if(!hasCreatedBl(order))throw Error('BL publié absent : préparation à terminer avant achat');
}
const postBlAutomaticClaimGuard=` AND EXISTS(SELECT 1 FROM orders o WHERE o.id=$4 AND o.reference=temu_label_jobs.reference
 AND NOT o.archived AND NOT o.simulation AND NOT o.partial_mode AND o.transport_choice IS NULL
 AND o.erp_live->'bl'->>'id'=$5::text
 AND o.erp_live->'bl'->>'status' IN ('pending','make_the_shipment','in_preparation','ready_to_ship')
 AND o.suspension=$6::jsonb
 AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id)
 AND NOT EXISTS(SELECT 1 FROM temu_label_documents t WHERE t.reference=o.reference))`;

export function temuShipping(db,api,{quoteOrderPolicy=null,fixedWeight=null}={}){
 const active=new Set();let warehouseCache=null,warehouseAt=0;
 async function locked(reference,fn){if(!/^PO-\d+(?:-\d+)+$/.test(reference))throw new Error('Référence TEMU invalide');if(active.has(reference))throw new Error('Cette commande est déjà en traitement');active.add(reference);try{return await fn();}finally{active.delete(reference);}}
 const job=async reference=>(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
 async function quote(reference,channelId,fresh={}){
  const localOrders=(await db.query('SELECT * FROM orders WHERE reference=$1',[reference])).rows;if(quoteOrderPolicy)await quoteOrderPolicy(reference);else for(const order of localOrders){const blocked=suspensionBlock(order);if(blocked)throw Error(blocked);}
  const excelOrder=!quoteOrderPolicy&&localOrders.find(isTemuExcel);
  const blOrder=!quoteOrderPolicy&&localOrders.find(o=>!o.archived&&hasCreatedBl(o));
  if(blOrder)assertExistingBlLabelOrder(blOrder);
  let excelProof;
  if(excelOrder&&!blOrder){
   if(excelOrder.archived||excelOrder.label_status==='cancelled'||['cancelled','shipped','in_transit','delivered'].includes(excelOrder.tracking_status)||(excelOrder.issue&&!(usesRecordedBc(excelOrder)&&retiredCommercialControl(excelOrder.issue)))||!excelOrder.source_payload.temuExcelPreparation||excelOrder.resolution_pending_resume&&!await completedExcelPreparation(db,excelOrder))throw Error('Excel TEMU : préparation à terminer avant achat');
   await assertLabelStockGate(db,excelOrder);
   const lines=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[excelOrder.id])).rows;if(!usesRecordedBc(excelOrder))verifiedExcelCommercial(excelOrder,lines);
   excelProof={order:excelOrder,lines};
  }
  const knownWeight=Number(localOrders[0]?.weight_kg);const parcelWeight=fixedWeight??(excelOrder?'0.25':Number.isFinite(knownWeight)&&knownWeight>0.25?String(Math.ceil(knownWeight*1000)/1000):'0.25');
  const detail=fresh.detail||await api.read('bg.order.detail.v2.get',{parentOrderSn:reference}),info=inspectTemu(detail,reference);
  if(excelProof)verifyExcelTemuDetail(excelProof.order,excelProof.lines,detail);
  const existing=fresh.shipments||await readTemuShipments(api,reference,detail);
  if(info.packages.length||(existing.shipmentInfoDTO||[]).length)throw new Error('Une expédition existe déjà dans TEMU : utiliser Récupérer les étiquettes');
  if(!info.lines.length)throw new Error('Commande TEMU non entièrement à expédier');
  if(!warehouseCache||Date.now()-warehouseAt>300000){warehouseCache=(await api.read('bg.logistics.warehouse.list.get',{returnEnableBuyShippingLabelOnly:true})).warehouseList||[];warehouseAt=Date.now();}const warehouses=warehouseCache;
  const usable=warehouses.filter(w=>w.enableBuyShippingLabel!==false),defaults=usable.filter(w=>w.defaultWarehouse);const warehouse=defaults.length===1?defaults[0]:usable.length===1?usable[0]:null;if(!warehouse?.warehouseId)throw new Error('Entrepôt TEMU absent ou ambigu');
  const base={warehouseId:warehouse.warehouseId,weight:parcelWeight,weightUnit:'kg',length:'10.00',width:'8.00',height:'0.50',dimensionUnit:'cm'};
  const raw=await api.read('bg.logistics.shippingservices.get',{...base,shipOrderInfoList:info.lines,signatureOnDelivery:info.signature});
  const offers=(raw.onlineChannelDtoList||[]).map(o=>{try{return {...o,...offerParcel(o,base,info)};}catch(e){return {...o,unavailableReason:e.message};}});
  const eligible=offers.filter(o=>!o.unavailableReason).sort((a,b)=>a.amount-b.amount||a.channelId-b.channelId);
  if(new Set(eligible.map(o=>o.currency)).size>1)throw new Error('Offres dans plusieurs devises : vérification nécessaire');
  const chosen=channelId?eligible.find(o=>o.channelId===Number(channelId)):eligible[0];if(!chosen)throw new Error('TEMU · Aucun service disponible : '+(offers.length?[...new Set(offers.map(o=>o.unavailableReason).filter(Boolean))].join(' ; ').slice(0,300):'aucune offre renvoyée par TEMU'));
  const request={sendType:0,shipLater:true,shipLaterLimitTime:String(info.hours),sendRequestList:[chosen.parcel]};
  const plan={reference,offers,selected:chosen.channelId,amount:chosen.amount,currency:chosen.currency,request,orderFingerprint:info.fingerprint,expiresAt:Date.now()+600000};if(excelProof)plan.preparationFingerprint=hash(excelShipmentProof(excelProof.order,excelProof.lines));if(blOrder)plan.blAuthority={orderId:blOrder.id,blId:String(blOrder.erp_live.bl.id)};const recorded=!!blOrder||localOrders.some(o=>!o.archived&&usesRecordedBc(o));plan.executionAuthority=blOrder?'recorded_bl':recorded?'recorded_bc':'source';plan.id=recorded?recordedBcQuoteId(plan):hash({request,amount:plan.amount,currency:plan.currency,orderFingerprint:plan.orderFingerprint,...(excelProof?{preparationFingerprint:plan.preparationFingerprint}:{})});Object.defineProperty(plan,'excelProof',{value:excelProof});return plan;
 }
 async function recover(reference,fresh={}){return locked(reference,async()=>{
  if(hasExternalLabel((await db.query("SELECT channel,source_payload FROM orders WHERE reference=$1 AND channel='temu'",[reference])).rows[0]))return job(reference);
  let j=await job(reference),packages=fresh.packages||j?.packages||[];
  if(!packages.length){const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:reference});const raw=await readTemuShipments(api,reference,detail);const items=raw.shipmentInfoDTO;packages=[...new Set([...inspectTemu(detail,reference).packages,...items.flatMap(p=>[p,...(p.subPackageShipmentInfoList||[])]).map(p=>{if(p.parentOrderSn&&p.parentOrderSn!==reference)throw new Error('Colis d’une autre commande');return p.packageSn;}).filter(Boolean)])];}
  if(!packages.length)throw new Error('Aucun colis retrouvé : vérifier TEMU avant tout nouvel achat');if(packages.some(p=>!/^PK-\d+$/.test(p)))throw new Error('Identifiant de colis invalide');
  await db.query(`INSERT INTO temu_label_jobs(reference,status,packages) VALUES($1,'pending',$2) ON CONFLICT(reference) DO UPDATE SET packages=excluded.packages`,[reference,JSON.stringify(packages)]);
  const result=await api.read('bg.logistics.shipment.result.get',{packageSnList:packages});result.source='temu_direct';result.observedAt=new Date().toISOString();
  for(const p of result.packageInfoResultList||[]){p.carrier=p.shippingCompanyName||p.carrier;p.amount=p.estimatedAmount??p.amount;p.currency=p.estimatedCurrencyCode||p.currency;p.costEstimated=p.estimatedAmount!==undefined;}
  const details=result.packageInfoResultList||[];for(const p of details){if(!packages.includes(p.packageSn)||!p.orderSendInfoList?.length||!p.orderSendInfoList.some(l=>l.parentOrderSn===reference))throw new Error('Identité du colis non vérifiable');}
  if(new Set(details.map(p=>p.packageSn)).size!==packages.length||details.length!==packages.length)throw new Error('Résultat TEMU incomplet : récupération à relancer');
  const {count,documentWarnings}=await recoverMissingTemuPdfs(db,api,reference,details);
  const refused=details.find(p=>Number(p.shippingLabelStatus)===2);
  const unavailable=count<packages.length&&documentWarnings.length>0;
  const status=refused?'shipment_error':count===packages.length?'complete':unavailable?'document_unavailable':'pending';
  const error=refused?('TEMU · Étiquette refusée : '+String(refused.failReasonText||'motif non communiqué').slice(0,250)):unavailable?(documentWarnings.some(w=>/picked up.*cannot be printed/i.test(w))?'TEMU · PDF non réimprimable : colis déjà collecté':'TEMU · PDF indisponible : '+documentWarnings.join(' ; ').slice(0,300)):status==='pending'?'TEMU · PDF en attente chez TEMU':null;
  await db.query('UPDATE temu_label_jobs SET status=$2,error=$3,result=$4::jsonb,updated_at=now() WHERE reference=$1',[reference,status,error,JSON.stringify({...result,documentWarnings})]);return job(reference);
 });}
 return {list:()=>api.read('bg.order.list.v2.get',{pageNumber:1,pageSize:20,sortby:'createTime'}),history:async()=>(await db.query('SELECT *, (SELECT count(*)::int FROM temu_label_documents d WHERE d.reference=j.reference) documents FROM temu_label_jobs j ORDER BY updated_at DESC LIMIT 100')).rows,
  prepare:(reference,channelId,fresh={})=>locked(reference,async()=>{if(hasExternalLabel((await db.query("SELECT channel,source_payload FROM orders WHERE reference=$1 AND channel='temu'",[reference])).rows[0]))throw Error('Étiquette externe enregistrée : aucun nouvel achat TEMU');const old=await job(reference);if(old?.attempt_id||old?.packages?.length)throw new Error('Une tentative ou expédition existe : récupérer son résultat');const plan=await quote(reference,channelId,fresh);await db.query(`INSERT INTO temu_label_jobs(reference,status,plan) VALUES($1,'ready',$2) ON CONFLICT(reference) DO UPDATE SET status='ready',plan=excluded.plan,error=null,updated_at=now()`,[reference,JSON.stringify(plan)]);return plan;}),
  async buy(reference,planId,confirmedAmount,{beforeClaim}={}){await locked(reference,async()=>{if(hasExternalLabel((await db.query("SELECT channel,source_payload FROM orders WHERE reference=$1 AND channel='temu'",[reference])).rows[0]))throw Error('Étiquette externe enregistrée : aucun nouvel achat TEMU');
   if(api.canBuy===false)throw Error('TEMU · Accès actuel en lecture seule : achat indisponible');
   const j=await job(reference);if(!j?.plan||j.status!=='ready'||j.attempt_id)throw new Error('Aperçu absent ou achat déjà tenté');if(j.plan.id!==planId||Number(confirmedAmount)!==j.plan.amount||Date.now()>j.plan.expiresAt)throw new Error('Aperçu expiré ou différent : préparer à nouveau');
   const current=await quote(reference,j.plan.selected);if(current.id!==j.plan.id){await db.query('UPDATE temu_label_jobs SET plan=$2 WHERE reference=$1',[reference,JSON.stringify(current)]);throw new Error('Prix ou commande modifiés : relire un nouvel aperçu');}
   const admission=beforeClaim?await beforeClaim(current):null;
   const proof=admission?.orderProof;
   if(beforeClaim&&(!proof||admission.allowed!==true||!Number.isFinite(admission.audit?.profit)||admission.audit.profit<=0||admission.audit.planId!==current.id))throw Error('Preuve de préparation et marge positive automatique absente');
   const guard=proof&&current.blAuthority?postBlAutomaticClaimGuard:proof?` AND EXISTS(SELECT 1 FROM orders o WHERE o.id=$4 AND o.reference=temu_label_jobs.reference AND NOT o.archived AND NOT o.simulation AND NOT o.partial_mode AND NOT o.resolution_pending_resume AND o.issue IS NULL AND o.transport_choice IS NULL AND o.erp_live=$5::jsonb AND o.source_payload=$6::jsonb AND o.address=$7::jsonb AND o.suspension=$8::jsonb AND o.weight_kg IS NOT DISTINCT FROM $9::numeric AND coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY source_line,id) FROM lines l WHERE l.order_id=o.id),'[]'::jsonb)=$10::jsonb AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='complete') AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id) AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id) AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id) AND NOT EXISTS(SELECT 1 FROM temu_label_documents t WHERE t.reference=o.reference) AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting','review')) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting','review')))`:'';
   const args=[reference,randomUUID(),JSON.stringify(j.plan),...(proof?(current.blAuthority?[proof.id,current.blAuthority.blId,JSON.stringify(proof.suspension)]:[proof.id,JSON.stringify(proof.erpLive),JSON.stringify(proof.sourcePayload),JSON.stringify(proof.address),JSON.stringify(proof.suspension),proof.weight,JSON.stringify(proof.lines||[])]):[])];
   const claimSql="UPDATE temu_label_jobs SET status='purchasing',attempt_id=$2,updated_at=now() WHERE reference=$1 AND status='ready' AND attempt_id IS NULL AND plan=$3::jsonb"+guard+" RETURNING reference,attempt_id";
   const claim=await (current.blAuthority||current.excelProof?db.transaction(async tx=>{
    const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[current.blAuthority?.orderId||current.excelProof.order.id])).rows[0];
    if(current.blAuthority){
     if(!o||String(o.erp_live?.bl?.id)!==current.blAuthority.blId)throw Error('BL associé modifié avant achat');
     assertExistingBlLabelOrder(o);
     if(hasExternalLabel(o)||(await tx.query('SELECT 1 FROM temu_label_documents WHERE reference=$1 LIMIT 1',[reference])).rows.length)throw Error('Étiquette existante à conserver : aucun nouvel achat');
     const claimed=await tx.query(claimSql,args);
     if(proof&&claimed.rows.length)await tx.query('INSERT INTO temu_automatic_purchase_audit(attempt_id,reference,plan_id,decision) VALUES($1,$2,$3,$4)',[claimed.rows[0].attempt_id,reference,current.id,JSON.stringify(admission.audit)]);
     return claimed;
    }
    const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
    if(hash(excelShipmentProof(o,lines))!==current.preparationFingerprint)throw Error('Préparation Excel modifiée avant achat');
    if(o.resolution_pending_resume&&!await completedExcelPreparation(tx,o))throw Error('Préparation Excel modifiée avant achat');
    await assertLabelStockGate(tx,o);
    const claimed=await tx.query(claimSql,args);
    if(proof&&claimed.rows.length)await tx.query('INSERT INTO temu_automatic_purchase_audit(attempt_id,reference,plan_id,decision) VALUES($1,$2,$3,$4)',[claimed.rows[0].attempt_id,reference,current.id,JSON.stringify(admission.audit)]);
    return claimed;
   }):db.query(proof?"WITH claimed AS ("+claimSql+") INSERT INTO temu_automatic_purchase_audit(attempt_id,reference,plan_id,decision) SELECT attempt_id,reference,$11,$12::jsonb FROM claimed RETURNING reference":claimSql,proof?[...args,current.id,JSON.stringify(admission.audit)]:args));if(!claim.rows.length)throw new Error('Achat déjà engagé ou commande/devis modifiés');
   try{const r=await api.buy(current.request);if(!r.packageSnList?.length||r.packageSnList.some(p=>!/^PK-\d+$/.test(p)))throw new Error('Achat sans identifiant vérifiable');await db.query("UPDATE temu_label_jobs SET packages=$2,status='pending',updated_at=now() WHERE reference=$1",[reference,JSON.stringify(r.packageSnList)]);}catch(e){await db.query("UPDATE temu_label_jobs SET status='uncertain',error=$2 WHERE reference=$1",[reference,e.message]);throw new Error('Résultat d’achat incertain. Ne pas racheter : utiliser la récupération et vérifier TEMU.');}
  });return recover(reference);},recover};
}
