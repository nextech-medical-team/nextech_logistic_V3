import {randomUUID} from 'node:crypto';
import {hash,inspectTemu,offerParcel,readTemuShipments,temuParcelWeight} from './temu-shipping.mjs';
import {hasPartialCreatedBl} from './created-bl-label.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {assertHistoricalBlNumber} from './bl-numbering.mjs';
import {assertErplainReadyTransition} from './erplain-ready-transition.mjs';
import {partialLabelWeight} from './partial-label-recovery.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {hasExternalLabel} from './temu-external-label.mjs';
import {preserveTemuPartialLabels} from './temu-partial-labels.mjs';

const identity=d=>hash({bl:String(d.bl?.id),selection:d.selection.map(l=>({lineId:String(l.lineId),variantId:String(l.variantId),sku:l.sku,quantity:Number(l.quantity),ordered:Number(l.ordered)}))});
const lineKey=lines=>JSON.stringify(lines.map(l=>[String(l.parentOrderSn),String(l.orderSn),Number(l.quantity)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
const packageIds=result=>[...new Set((result?.packageInfoResultList||[]).map(p=>p.packageSn).filter(Boolean))];
function admissible(o,d){
 if(!o||o.channel!=='temu'||!o.partial_mode||d.order_id!==o.id||d.label_choice!=='bl_only_temu'||d.environment!=='production'||!hasPartialCreatedBl(d))throw Error('Livraison partielle TEMU publiée requise');
 const held=suspensionBlock(o);if(held)throw Error(held);
 if(o.archived||['cancelled','shipped','in_transit','delivered'].includes(o.tracking_status)||o.label_status==='cancelled')throw Error('Commande annulée ou déjà expédiée : aucune nouvelle étiquette');
 if(o.transport_choice||hasExternalLabel(o))throw Error('Étiquette ou transport externe à préserver');
 assertHistoricalBlNumber(d.bl);
}

// Translate the saved partial allocation into supplier sale units (e.g. 50
// Erplain units = one TEMU box). This describes the parcel; it does not recheck
// BC, stock, prices, mappings or preparation fingerprints after BL creation.
export function partialTemuLines(o,d,source,detail){
 const used=new Set(),lines=[];
 for(const selected of d.selection){
  const matches=source.filter(l=>String(l.source_payload?.erplainSourceVariantId||'')===String(selected.variantId)||String(l.target_sku||l.source_sku)===selected.sku);
  if(matches.length!==1)throw Error('TEMU · Article de la livraison non identifiable : '+selected.sku);
  const l=matches[0],orderSn=String(l.source_payload?.temuOrderSn||l.source_line||''),item=detail.orderList?.find(i=>String(i.orderSn)===orderSn);
  const quantity=Number(l.source_payload?.marketplaceQuantity??l.quantity)*Number(selected.quantity)/Number(selected.ordered);
  if(!item||used.has(orderSn)||!Number.isSafeInteger(quantity)||quantity<=0)throw Error('TEMU · Quantité du colis non représentable en unités TEMU : '+selected.sku);
  if(Number(item.quantity)>0&&quantity>Number(item.quantity))throw Error('TEMU · Quantité à expédier indisponible pour '+selected.sku);
  used.add(orderSn);lines.push({parentOrderSn:o.reference,orderSn,quantity});
 }
 if(!lines.length)throw Error('TEMU · Livraison sans article');
 return lines;
}

async function readCurrentPartialBl(api,bl){const r=await api.request('query V3PartialReadySource($id:ID!){ShippingOrder(id:$id){id label status}}',{id:String(bl.id)});const b=r.ShippingOrder;if(String(b?.id)!==String(bl.id)||b.label!==bl.label)throw Error('ERPLAIN · Statut du BL partiel non vérifiable');assertHistoricalBlNumber(b);if(['cancelled','shipped','delivered','completed'].includes(b.status))throw Object.assign(Error('ERPLAIN · BL annulé ou déjà expédié : aucun nouvel achat'),{code:'PARTIAL_BL_INACTIVE',observedBl:b});return b;}

// Status-only operation: no BC/stock/quantity prerequisites and no stock writes.
export async function readyPartialBl(api,bl,{beforeChange=async()=>{}}={}){
 const read=()=>readCurrentPartialBl(api,bl);
 let before=await read();try{assertErplainReadyTransition(before.status,'ready_to_ship');}catch(e){e.observedBl=before;throw e;}
 if(before.status==='ready_to_ship')return {...bl,...before};
 if(!['pending','make_the_shipment'].includes(before.status))throw Error('ERPLAIN · Statut du BL incompatible : '+before.status);
 await beforeChange();
 before=await read();try{assertErplainReadyTransition(before.status,'ready_to_ship');}catch(e){e.observedBl=before;throw e;}
 if(before.status==='ready_to_ship')return {...bl,...before};
 if(!['pending','make_the_shipment'].includes(before.status))throw Error('ERPLAIN · Statut du BL incompatible : '+before.status);
 await api.request('mutation V3PartialDeliveryReady($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id label status}}',{id:String(bl.id),input:{label:before.label,status:'ready_to_ship'}});
 const after=await read();if(after.status!=='ready_to_ship')throw Error('ERPLAIN · Passage du BL partiel prêt à livrer non confirmé');
 return {...bl,...after};
}

export function partialTemuLabelService(db,local,erplain,{enabled=()=>true,preserveLabels=preserveTemuPartialLabels}={}){
 async function context(id,tx=db){const d=(await tx.query('SELECT * FROM partial_deliveries WHERE id=$1',[id])).rows[0];if(!d)throw Error('Livraison introuvable');const o=(await tx.query('SELECT * FROM orders WHERE id=$1',[d.order_id])).rows[0];admissible(o,d);return {o,d};}
 async function persist(d,status,changes={},error=null){d.temu_label={...d.temu_label,...changes};d.status=status;d.error=error;await db.query("UPDATE partial_deliveries SET status=$2,stage='temu_label',temu_label=$3,error=$4,updated_at=now() WHERE id=$1",[d.id,status,JSON.stringify(d.temu_label),error]);}
 async function supplier(o,d){return local.partialApi(o.reference,d.id);}
 async function selection(o,d,api){const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:o.reference});if(detail.parentOrderMap?.parentOrderSn!==o.reference)throw Error('TEMU · Identité de la commande non confirmée');const source=(await db.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;const lines=partialTemuLines(o,d,source,detail);return {detail,lines};}
 async function existing(o,d,api,detail,lines){
  const shipments=await readTemuShipments(api,o.reference,detail);
  const ids=[...new Set([...(d.temu_label?.packages||[]),...detail.orderList.flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)),...shipments.shipmentInfoDTO.flatMap(p=>[p,...(p.subPackageShipmentInfoList||[])]).map(p=>p.packageSn)].filter(Boolean))];
  if(ids.some(p=>!/^PK-\d+$/.test(p)))throw Error('TEMU · Identifiant de colis invalide');
  if(!ids.length){if(shipments.shipmentInfoDTO.length)throw Error('TEMU · Expédition existante sans identité vérifiable');return [];}
  const siblings=(await db.query("SELECT carrier_result,temu_label FROM partial_deliveries WHERE order_id=$1 AND id<>$2",[o.id,d.id])).rows;
  const assigned=new Set(siblings.flatMap(s=>[...packageIds(s.carrier_result),...(s.temu_label?.packages||[])]));
  const candidates=ids.filter(p=>!assigned.has(p));if(!candidates.length)return [];
  const result=await api.read('bg.logistics.shipment.result.get',{packageSnList:candidates});
  const parcels=result.packageInfoResultList;if(!Array.isArray(parcels)||parcels.length!==candidates.length||new Set(parcels.map(p=>p.packageSn)).size!==candidates.length)throw Error('TEMU · Résultat des colis incomplet : aucun nouvel achat');
  const matched=[];
  for(const p of parcels){if(!candidates.includes(p.packageSn)||!p.orderSendInfoList?.length)throw Error('TEMU · Identité du colis non vérifiable');const own=p.orderSendInfoList.filter(l=>l.parentOrderSn===o.reference);if(!own.length)throw Error('TEMU · Colis d’une autre commande');if(lineKey(own)===lineKey(lines))matched.push(p);else if(own.some(l=>lines.some(w=>w.orderSn===l.orderSn)))throw Error('TEMU · Une expédition couvre déjà une partie de cette sélection : rapprochement requis');}
  if(matched.length>1)throw Error('TEMU · Plusieurs colis correspondent à la livraison : rapprochement requis');
  if(d.temu_label?.packages?.length&&(!matched.length||d.temu_label.packages.some(id=>!matched.some(p=>p.packageSn===id))))throw Error('TEMU · Achat conservé, colis attendu non confirmé');
  return matched;
 }
 async function recover(o,d,api,parcels){
  const previous=d.carrier_result?.packageInfoResultList||[];
  for(const p of previous){const next=parcels.find(x=>x.packageSn===p.packageSn);if(!next||p.trackingNumber&&next.trackingNumber!==p.trackingNumber)throw Error('TEMU · Suivi existant différent : documents conservés');}
  const packages=parcels.map(p=>p.packageSn);await db.query('UPDATE partial_deliveries SET carrier_result=$2,tracking=$3,carrier=$4,parcel_count=$5 WHERE id=$1',[d.id,JSON.stringify({source:'temu_partial',packageInfoResultList:parcels}),JSON.stringify(parcels.map(p=>p.trackingNumber).filter(Boolean)),'temu',packages.length]);
  await persist(d,'temu_wait',{packages,nextAt:new Date(Date.now()+60000).toISOString()});
  for(let index=0;index<parcels.length;index++){
   const p=parcels[index];if(Number(p.shippingLabelStatus)===2)throw Error('TEMU · Étiquette refusée : '+String(p.failReasonText||'motif fournisseur absent'));
   const saved=(await db.query('SELECT pdf FROM partial_documents WHERE delivery_id=$1 AND document_index=$2',[d.id,index])).rows[0];if(saved){if(!saved.pdf?.length)throw Error('PDF archivé illisible : conserver et vérifier');continue;}
   if(Number(p.shippingLabelStatus)!==1||!p.trackingNumber)continue;
   await withShipmentLock(async()=>{const shared=(await db.query('SELECT pdf FROM temu_label_documents WHERE reference=$1 AND package=$2',[o.reference,p.packageSn])).rows[0];let pdf=shared?.pdf;
    if(!pdf){const docs=await api.read('bg.logistics.shipment.document.get',{documentType:'SHIPPING_LABEL_PDF',packageSnList:[p.packageSn]});const entries=docs.shippingLabelUrlList||[];if(entries.some(x=>x.packageSn!==p.packageSn||x.documentType!=='SHIPPING_LABEL_PDF'))throw Error('TEMU · PDF associé à un autre colis');if(entries.length!==1)throw Error('TEMU · PDF en attente chez TEMU');pdf=await api.pdf(entries[0].url);}
    if(!pdf?.length||!Buffer.from(pdf).subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('TEMU · PDF fournisseur invalide');
    await db.query('INSERT INTO partial_documents(delivery_id,document_index,pdf) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[d.id,index,pdf]);
   },['temu-pdf:'+p.packageSn]);
  }
  const count=Number((await db.query('SELECT count(*) n FROM partial_documents WHERE delivery_id=$1 AND octet_length(pdf)>0',[d.id])).rows[0].n);
  if(count===packages.length&&parcels.every(p=>p.trackingNumber))await persist(d,d.temu_label?.readyError?'temu_ready_review':'ready',{nextAt:null,plan:null},d.temu_label?.readyError||null);
  else await persist(d,'temu_wait',{nextAt:new Date(Date.now()+60000).toISOString()},'TEMU · PDF ou suivi en attente chez TEMU');
  return {status:d.status};
 }
 async function quote(o,d,api,detail,lines){
  const uncertain=(await db.query("SELECT id FROM partial_deliveries WHERE order_id=$1 AND id<>$2 AND temu_label->>'attemptId' IS NOT NULL AND coalesce(jsonb_array_length(temu_label->'packages'),0)=0",[o.id,d.id])).rows;
  if(uncertain.length)throw Error('TEMU · Achat d’une autre livraison partielle incertain : rapprochement requis');
  const old=(await db.query('SELECT status,attempt_id,packages FROM temu_label_jobs WHERE reference=$1',[o.reference])).rows[0];
  if(['purchasing','uncertain'].includes(old?.status)||old?.attempt_id&&!old.packages?.length)throw Error('TEMU · Autre achat en cours ou incertain : aucun nouvel achat');
  if(d.temu_label?.attemptId)throw Error('TEMU · Achat déjà tenté : récupération uniquement, aucun nouvel achat');
  const selectedDetail={...detail,orderList:lines.map(l=>({...detail.orderList.find(i=>String(i.orderSn)===l.orderSn),quantity:l.quantity,packageSnInfo:[]}))};const info=inspectTemu(selectedDetail,o.reference);
  const weights=(await db.query('SELECT sku,weight_kg FROM products WHERE sku=ANY($1::text[])',[d.selection.map(l=>l.sku)])).rows;
  const weight=partialLabelWeight(d,o,weights).weight;
  const raw=await api.read('bg.logistics.warehouse.list.get',{returnEnableBuyShippingLabelOnly:true}),warehouses=(raw.warehouseList||[]).filter(w=>w.enableBuyShippingLabel!==false),defaults=warehouses.filter(w=>w.defaultWarehouse),warehouse=defaults.length===1?defaults[0]:warehouses.length===1?warehouses[0]:null;if(!warehouse?.warehouseId)throw Error('TEMU · Entrepôt absent ou ambigu');
  const base={warehouseId:warehouse.warehouseId,weight:temuParcelWeight({weight_kg:weight}),weightUnit:'kg',length:'10.00',width:'8.00',height:'0.50',dimensionUnit:'cm'};
  const offered=await api.read('bg.logistics.shippingservices.get',{...base,shipOrderInfoList:lines,signatureOnDelivery:info.signature});const offers=[];
  for(const o of offered.onlineChannelDtoList||[])try{offers.push({...o,...offerParcel(o,base,info)});}catch{}
  offers.sort((a,b)=>a.amount-b.amount||a.channelId-b.channelId);if(!offers.length||new Set(offers.map(o=>o.currency)).size!==1)throw Error('TEMU · Aucun devis admissible dans une devise unique');
  const offer=offers[0],request={sendType:0,shipLater:true,shipLaterLimitTime:String(info.hours),sendRequestList:[offer.parcel]};const plan={id:hash({request,amount:offer.amount,currency:offer.currency,identity:identity(d)}),amount:offer.amount,currency:offer.currency,request,expiresAt:Date.now()+600000,identity:identity(d),carrier:offer.shippingCompanyName||offer.shipCompanyName||offer.channelName||'TEMU'};
  await db.query('UPDATE partial_deliveries SET weight_kg=$2 WHERE id=$1',[d.id,weight]);return plan;
 }
 async function advance(id){return withShipmentLock(async()=>{
  if(!enabled())return {status:'paused'};const {o,d}=await context(id);
  let readyError=null;try{const bl=await readyPartialBl(erplain,d.bl,{beforeChange:()=>db.transaction(tx=>preserveLabels(tx,o))});d.bl=bl;await db.query('UPDATE partial_deliveries SET bl=$2 WHERE id=$1',[d.id,JSON.stringify(bl)]);}catch(e){readyError=e.message;if(e.observedBl){d.bl={...d.bl,...e.observedBl};await db.query('UPDATE partial_deliveries SET bl=$2 WHERE id=$1',[d.id,JSON.stringify(d.bl)]);}if(e.code==='PARTIAL_BL_INACTIVE'){await persist(d,'temu_ready_review',{readyError,nextAt:null},readyError);return {status:d.status,error:readyError};}}
  d.temu_label={...d.temu_label,readyError};
  try{const api=await supplier(o,d),{detail,lines}=await selection(o,d,api),parcels=await existing(o,d,api,detail,lines);if(parcels.length)return await recover(o,d,api,parcels);
   if(d.temu_label?.attemptId)throw Error('TEMU · Résultat d’achat incertain : aucun rachat, vérifier les colis fournisseur');
   if((await db.query('SELECT 1 FROM partial_documents WHERE delivery_id=$1 LIMIT 1',[d.id])).rows.length||d.tracking?.length||d.carrier_result)throw Error('Étiquette ou résultat existant : conserver et rapprocher sans nouvel achat');
   const plan=await quote(o,d,api,detail,lines);await persist(d,'temu_confirm',{plan,nextAt:null},readyError);return {status:d.status,plan};
  }catch(e){await persist(d,'temu_wait',{nextAt:new Date(Date.now()+60000).toISOString()},e.message);return {status:d.status,error:e.message};}
 },['stock-mutations']);}
 async function buy(id,planId,amount,confirmPurchase){return withShipmentLock(async()=>{
  if(confirmPurchase!==true)throw Error('Confirmation explicite de l’achat TEMU requise');if(!enabled())throw Error('Parcours TEMU suspendu');const {o,d}=await context(id),saved=d.temu_label?.plan;if(d.status!=='temu_confirm'||!saved||saved.id!==planId||saved.amount!==Number(amount)||saved.expiresAt<=Date.now()||saved.identity!==identity(d))throw Error('Devis absent, expiré ou livraison modifiée : actualiser');
  const api=await supplier(o,d);if(api.canBuy===false)throw Error('TEMU · Accès en lecture seule : achat indisponible');const {detail,lines}=await selection(o,d,api),parcels=await existing(o,d,api,detail,lines);if(parcels.length)return recover(o,d,api,parcels);
  const current=await quote(o,d,api,detail,lines);if(current.id!==saved.id){await persist(d,'temu_confirm',{plan:current,nextAt:null},d.temu_label?.readyError);throw Error('Devis modifié : relire le nouveau montant');}
  await readCurrentPartialBl(erplain,d.bl);
  const attemptId=randomUUID();await db.transaction(async tx=>{const locked=(await tx.query('SELECT * FROM partial_deliveries WHERE id=$1 FOR UPDATE',[id])).rows[0],order=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];admissible(order,locked);if(identity(locked)!==saved.identity||locked.status!=='temu_confirm'||locked.temu_label?.attemptId||locked.temu_label?.plan?.id!==planId)throw Error('Achat déjà engagé ou livraison modifiée');
   const active=(await tx.query("SELECT order_id FROM erp_live_jobs WHERE order_id=$1 AND status='processing' UNION ALL SELECT order_id FROM correction_jobs WHERE order_id=$1 AND status IN ('applying','checking') UNION ALL SELECT order_id FROM resolution_jobs WHERE order_id=$1 AND status='running'",[o.id])).rows;if(active.length)throw Error('Traitement en cours : attendre sa fin avant achat');
   if((await tx.query('SELECT 1 FROM partial_documents WHERE delivery_id=$1 LIMIT 1',[id])).rows.length||locked.tracking?.length||locked.carrier_result)throw Error('Étiquette existante à préserver');
   d.temu_label={...locked.temu_label,attemptId,state:'purchasing',nextAt:new Date(Date.now()+60000).toISOString()};await tx.query("UPDATE partial_deliveries SET status='temu_wait',stage='temu_label',temu_label=$2,error=null,updated_at=now() WHERE id=$1",[id,JSON.stringify(d.temu_label)]);
  });
  try{const result=await api.buy(current.request);if(!result.packageSnList?.length||result.packageSnList.some(p=>!/^PK-\d+$/.test(p)))throw Error('Achat sans identifiant vérifiable');await persist(d,'temu_wait',{packages:result.packageSnList,state:'paid',nextAt:new Date().toISOString()});}
  catch(e){await persist(d,'temu_wait',{state:'uncertain',nextAt:new Date(Date.now()+60000).toISOString()},'TEMU · Résultat d’achat incertain : récupération uniquement. '+e.message);throw Error('Résultat d’achat incertain : ne pas racheter ; récupération programmée');}
  return advance(id);
 },['stock-mutations']);}
 return {advance,buy};
}
