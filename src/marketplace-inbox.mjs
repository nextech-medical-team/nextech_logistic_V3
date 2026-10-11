import {maskedTemuAddressFields} from './temu-address-observation.mjs';
import {relayLabelObservation} from './relay-label-observation.mjs';
import {readShopifyRelay,relayComparisonAddress} from './shopify-relay-source.mjs';
import {shopifyDeliveryMode} from './shopify-delivery.mjs';
import {shopifyCancellationReason} from './shopify-cancellation-policy.mjs';
import {platformReceiptDisposition} from './platform-receipt-version.mjs';
import {authorizedFreshTemu} from './temu-authorized-reimport.mjs';
import {recoverCompleteTemuImport} from './temu-import-recovery.mjs';
import {initialMarketplaceHold} from './temu-initial-hold.mjs';
import {incompleteOrder,retainVisibleOrder,withinReceptionStart} from './order-visibility.mjs';
import {marketplaceChanged,marketplaceChangeFields} from './marketplace-comparison.mjs';
import {confirmedCancelledTemuLine} from './temu-active-amounts.mjs';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {marketplaceAllowed} from './marketplace-window.mjs';
import {normalizeShopifyOrders} from './marketplace-local-import.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

export async function initializeMarketplaceInbox(db){await db.exec(`
 CREATE TABLE IF NOT EXISTS marketplace_receipts(id TEXT PRIMARY KEY,channel TEXT NOT NULL,shop TEXT NOT NULL,delivery_id TEXT NOT NULL,payload JSONB NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(channel,shop,delivery_id));
 CREATE INDEX IF NOT EXISTS marketplace_receipts_pending ON marketplace_receipts(status,created_at);
 CREATE TABLE IF NOT EXISTS marketplace_read_issues(channel TEXT NOT NULL,shop TEXT NOT NULL,reference TEXT NOT NULL,code TEXT NOT NULL,message TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(channel,shop,reference));
 CREATE TABLE IF NOT EXISTS marketplace_cursors(channel TEXT NOT NULL,shop TEXT NOT NULL,watermark TIMESTAMPTZ,cursor TEXT,since_at TIMESTAMPTZ,until_at TIMESTAMPTZ,last_success TIMESTAMPTZ,error TEXT,PRIMARY KEY(channel,shop));
 CREATE TABLE IF NOT EXISTS marketplace_order_links(channel TEXT NOT NULL,shop TEXT NOT NULL,reference TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),version TIMESTAMPTZ,PRIMARY KEY(channel,shop,reference));`);if(db.recoverInterrupted!==false)await db.query("UPDATE marketplace_receipts SET status='pending',error=null WHERE status='processing'");}

export function validShopifyHmac(raw,header,secret){if(typeof header!=='string'||!secret||! /^[A-Za-z0-9+/]{43}=$/.test(header))return false;const supplied=Buffer.from(header,'base64'),expected=createHmac('sha256',secret).update(raw).digest();return supplied.length===expected.length&&timingSafeEqual(supplied,expected);}

export async function receiveMarketplace(db,{channel,shop,deliveryId,payload}){
 if(!['shopify','temu'].includes(channel)||typeof shop!=='string'||!shop||shop.length>255||typeof deliveryId!=='string'||!deliveryId||deliveryId.length>300)throw Error('Identité de réception invalide');
 const window=(await db.query("SELECT value FROM settings WHERE key='marketplace_automatic'")).rows[0]?.value;if(!window?.enabled)return {skipped:true,reason:'disabled'};
 try{if(!withinReceptionStart(channel,payload,window))return {skipped:true,reason:'outside-start-date'};}catch(e){if(!String(e.message).startsWith('Date source absente'))throw e;} // Retain an undated receipt for review; do not create an order.
 const raw=JSON.stringify(payload);if(Buffer.byteLength(raw)>2*1024*1024)throw Error('Réception trop volumineuse');const signature=createHash('sha256').update(raw).digest('hex');
 const id=randomUUID();const r=await db.query('INSERT INTO marketplace_receipts(id,channel,shop,delivery_id,payload,signature) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(channel,shop,delivery_id) DO NOTHING RETURNING id',[id,channel,shop,deliveryId,raw,signature]);
 if(r.rows.length)return {id,replayed:false};const old=(await db.query('SELECT id,signature FROM marketplace_receipts WHERE channel=$1 AND shop=$2 AND delivery_id=$3',[channel,shop,deliveryId])).rows[0];if(old.signature!==signature)throw Error('Réception déjà utilisée avec des données différentes');return {id:old.id,replayed:true};
}

export function normalizeTemuReceipt(payload,shop){
 const {detail,shipping,country}=payload,p=detail?.parentOrderMap,rawItems=detail?.orderList;
 const items=Array.isArray(rawItems)?rawItems.filter(l=>!confirmedCancelledTemuLine(l)):rawItems;
 if(Array.isArray(rawItems)&&new Set(rawItems.map(l=>String(l.orderSn||''))).size!==rawItems.length)throw Error('TEMU · Références de lignes dupliquées');
 if(!p?.parentOrderSn||!/^PO-/.test(p.parentOrderSn)||!Array.isArray(items)||!items.length||! /^[A-Z]{2}$/.test(country||''))throw Error('TEMU · Identité, pays ou articles incomplets');
 const seen=new Set();const lines=items.map(l=>{const skus=[...new Set((l.productList||[]).map(p=>String(p.extCode||'').trim()).filter(Boolean))];if(skus.length!==1)throw Error('TEMU · Référence vendeur absente ou multiple : '+String(l.skuId||l.orderSn));const quantity=Number(l.quantity);if(!l.orderSn||seen.has(l.orderSn)||!Number.isFinite(quantity)||quantity<=0)throw Error('TEMU · Quantité ou ligne non vérifiable');seen.add(l.orderSn);return {id:randomUUID(),source_line:String(l.orderSn),source_sku:skus[0],quantity,source_payload:{goodsName:l.goodsName,skuId:l.skuId,productList:l.productList,marketplaceQuantity:quantity,temuOrderSn:String(l.orderSn),mallId:shop}};});
 const date=new Date(Number(p.parentOrderTime)*1000);if(!Number.isFinite(date.getTime()))throw Error('TEMU · Date de commande absente');
 return {id:randomUUID(),channel:'temu',reference:p.parentOrderSn,recipient:shipping?.receiptName||'',address:{name:shipping?.receiptName||'',street:[shipping?.addressLine1,shipping?.addressLine2,shipping?.addressLine3].filter(Boolean).join(', '),postal:shipping?.postCode||'',city:shipping?.regionName3||'',country,phone:shipping?.mobile||'',email:shipping?.mail||''},source_date:date.toISOString(),source_payload:{origin:'temu_direct_receipt',mallId:shop,temuOrderDetail:detail,temuShippingInfo:shipping||{},sourceShop:shop,...(payload.sourceCoverage?{sourceCoverage:payload.sourceCoverage,logisticsObservation:payload.logisticsObservation}:{}),...(detail.v3Amounts?.data?{temuAmounts:{at:new Date().toISOString(),data:detail.v3Amounts.data},temuAmountsError:null}:{})},cancelled:Number(p.parentOrderStatus)===3,version:Number(p.updateTime)?new Date(Number(p.updateTime)*1000).toISOString():null,lines};
}

export async function applyMarketplaceReceipt(db,r,options={}){
 const fresh=authorizedFreshTemu(r,options);
 const window=(await db.query("SELECT value FROM settings WHERE key='marketplace_automatic'")).rows[0]?.value;if(!window?.enabled)return {skipped:true,reason:'disabled'};
 if(!fresh&&!withinReceptionStart(r.channel,r.payload,window))return {skipped:true,reason:'outside-start-date'};
 if(r.channel==='shopify'&&shopifyDeliveryMode(r.payload)==='relay'&&!readShopifyRelay(r.payload)){
  const {shopifyCollector,loadShopifyConfig}=await import('./marketplace-collection.mjs');
  const reader=options.shopifyReader||shopifyCollector(await loadShopifyConfig(process.env.DATA_DIR||'/var/lib/nextech-live'));
  if(reader.shop&&reader.shop!==r.shop)throw Error('Shopify · Boutique relais différente');
  const payload=await reader.order(String(r.payload.id||''));
  if(String(payload.id)!==String(r.payload.id)||payload.name!==r.payload.name||!readShopifyRelay(payload))throw Error('Shopify · Choix relais non vérifiable');
  r={...r,payload};
 }
 let o;try{if(r.payload.visibilityError)throw Error(r.payload.visibilityError);
 o=r.channel==='shopify'?{...normalizeShopifyOrders([r.payload])[0],channel:'shopify',cancelled:!!shopifyCancellationReason(r.payload),fulfilled:['fulfilled','partial','partially_fulfilled'].includes(r.payload.fulfillment_status),version:r.payload.updated_at||r.payload.created_at}:normalizeTemuReceipt(r.payload,r.shop);
 if(o.version&&!Number.isFinite(Date.parse(o.version)))throw Error('Date de modification marketplace invalide');
 }catch(e){if(fresh)throw e;o=incompleteOrder(r.channel,r.payload,r.shop,String(e.message).slice(0,500));}
 // Existing TEMU orders use the guarded catch-up writer. A partial receipt is
 // an observation, never an instruction to reset labels or business holds.
 if(r.channel==='temu'&&r.payload.sourceCoverage&&!fresh){
  const routed=await withShipmentLock(()=>db.transaction(async tx=>{
   const existing=(await tx.query('SELECT * FROM orders WHERE channel=$1 AND coalesce(source_reference,reference)=$2 ORDER BY received_at LIMIT 1 FOR UPDATE',[r.channel,o.reference])).rows[0];
   if(!existing)return null;
   if(existing.archived||existing.duplicate_of)return {skipped:true,reason:'inactive-existing-order'};
   const sourceShop=existing.source_payload?.sourceShop||existing.source_payload?.mallId;
   if(sourceShop&&String(sourceShop)!==r.shop)throw Error('Référence utilisée dans une autre boutique : rapprochement nécessaire');
   await tx.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[existing.id,JSON.stringify({temuReceiptObservation:{receivedAt:new Date().toISOString(),coverage:r.payload.sourceCoverage,payload:r.payload}})]);
   await tx.query('INSERT INTO temu_source_catchup(order_id) VALUES($1) ON CONFLICT(order_id) DO UPDATE SET next_at=least(temu_source_catchup.next_at,now())',[existing.id]);
   await tx.query('UPDATE order_recheck_monitor SET next_check=now(),requested=requested+1 WHERE order_id=$1',[existing.id]);
   return {existing:true,sourceCatchupQueued:true};
  }));
  if(routed)return routed;
 }
 if(o.visibilityHold)return withShipmentLock(()=>db.transaction(async tx=>{const existing=(await tx.query('SELECT * FROM orders WHERE channel=$1 AND coalesce(source_reference,reference)=$2 FOR UPDATE',[r.channel,o.reference])).rows[0];if(existing&&(existing.archived||existing.label_status==='cancelled'))return {excluded:true,id:existing.id};return {retained:true,id:await retainVisibleOrder(tx,o,o.source_payload.visibilityReason)};}));
 return withShipmentLock(()=>db.transaction(async tx=>{
  const link=(await tx.query('SELECT * FROM marketplace_order_links WHERE channel=$1 AND shop=$2 AND reference=$3 FOR UPDATE',[r.channel,r.shop,o.reference])).rows[0];
  if(fresh&&link)throw Error('Ancien lien marketplace encore présent : reprise interrompue');
  const existing=(await tx.query('SELECT * FROM orders WHERE channel=$1 AND coalesce(source_reference,reference)=$2 ORDER BY received_at LIMIT 1 FOR UPDATE',[r.channel,o.reference])).rows[0];
  if(platformReceiptDisposition({observedVersion:link?.version,incomingVersion:o.version,pending:!!existing?.source_payload?.marketplacePendingCorrection})==='skip')return {unchanged:true};
  if(fresh&&existing)throw Error('Ancienne fiche V3 encore présente : reprise interrompue');
  if(existing){const sourceShop=existing.source_payload?.sourceShop||existing.source_payload?.mallId;if(sourceShop&&String(sourceShop)!==r.shop)throw Error('Référence utilisée dans une autre boutique : rapprochement nécessaire');
   if(existing.source_payload?.visibilityHold){
    if(r.channel==='temu'&&maskedTemuAddressFields(o.source_payload.temuShippingInfo).length)throw Error('TEMU · Adresse masquée : adresse initiale complète requise avant récupération');
    const source={...o.source_payload,...(existing.source_payload?.externalLabel?{externalLabel:existing.source_payload.externalLabel}:{}),sourceShop:r.shop,visibilityHold:false,visibilityRecoveredAt:new Date().toISOString()};
    await tx.query('UPDATE orders SET recipient=$2,address=$3,source_date=$4,source_payload=$5,issue=$6 WHERE id=$1',[existing.id,o.recipient,JSON.stringify(o.address),o.source_date,JSON.stringify(source),'Données récupérées · Préparation à vérifier']);
    for(const l of o.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[l.id,existing.id,l.source_line,l.source_sku,l.quantity,JSON.stringify(l.source_payload)]);
    await recoverCompleteTemuImport(tx,existing,o,r);
    return {existing:true,recovered:true};
   }
   const prior=(await tx.query('SELECT source_line,source_sku,quantity FROM lines WHERE order_id=$1 ORDER BY source_line',[existing.id])).rows;
    const changed=marketplaceChanged(existing,prior,o);
    if(o.source_payload.shopifyRelay){
     const old=existing.source_payload?.shopifyRelay,relay=o.source_payload.shopifyRelay;
     if(!changed){relay.frozenOrderAddress=structuredClone(existing.address);relay.frozenClientAddress=structuredClone(relayComparisonAddress(existing,relay));}
     else if(old?.frozenOrderAddress&&old?.frozenClientAddress){relay.frozenOrderAddress=structuredClone(old.frozenOrderAddress);relay.frozenClientAddress=structuredClone(old.frozenClientAddress);}
    }
   // Save observation independently from operational preparation fields.
   await tx.query('UPDATE orders SET source_payload=source_payload||$2::jsonb WHERE id=$1',[existing.id,JSON.stringify({platformStatusObservation:{channel:r.channel,payload:r.payload,observedAt:new Date().toISOString(),version:o.version,indicative:true,preparationUnchanged:!changed},...(o.source_payload.shopifyRelay?{shopifyRelay:o.source_payload.shopifyRelay,shopifyDeliveryMode:o.source_payload.shopifyDeliveryMode}:{})})]);
   const relay=o.source_payload?.shopifyRelay;
   if(!changed&&relay?.selectedId&&!existing.archived&&existing.label_status!=='cancelled'&&!existing.suspension?.active&&!existing.suspension?.erplainCancellation){
    const job=(await tx.query('SELECT status,environment,carrier FROM carrier_jobs WHERE order_id=$1 FOR SHARE',[existing.id])).rows[0];
    if(job?.status==='ready'&&job.environment==='production'){
     const documents=(await tx.query('SELECT document_index,pdf FROM carrier_documents WHERE order_id=$1 ORDER BY document_index FOR SHARE',[existing.id])).rows;
     const observation=relayLabelObservation(existing,relay,job,documents);
     if(observation)await tx.query('UPDATE orders SET issue=$2,label_status=$3,source_payload=source_payload||$4::jsonb WHERE id=$1',[existing.id,observation.issue,observation.labelStatus,JSON.stringify({relayDestinationHold:observation.record})]);
    }
   }
   if(changed&&!existing.archived&&existing.label_status!=='cancelled'){await tx.query("UPDATE orders SET resolution_pending_resume=true,label_status='blocked',issue=$2,source_payload=source_payload||$3::jsonb WHERE id=$1",[existing.id,'Commande modifiée dans '+r.channel+' · Vérifier la préparation',JSON.stringify({marketplacePendingCorrection:r.payload,platformModificationFields:{version:o.version,fields:marketplaceChangeFields(existing,prior,o)},sourceShop:r.shop})]);}
   await tx.query('INSERT INTO marketplace_order_links(channel,shop,reference,order_id,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel,shop,reference) DO UPDATE SET version=excluded.version',[r.channel,r.shop,o.reference,existing.id,o.version]);return {existing:true,review:changed&&!existing.archived&&existing.label_status!=='cancelled'};
  }
  if(r.channel==='temu'&&maskedTemuAddressFields(o.source_payload.temuShippingInfo).length){const reason='TEMU · Adresse masquée : adresse initiale complète requise avant préparation';const retained=incompleteOrder(r.channel,r.payload,r.shop,reason);return {retained:true,id:await retainVisibleOrder(tx,retained,reason)};}
  const id=o.id;await tx.query(`INSERT INTO orders(id,channel,reference,source_reference,recipient,address,source_date,source_payload,resolution_pending_resume,label_status,issue,carrier) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,r.channel,o.reference,o.recipient,JSON.stringify(o.address),o.source_date,JSON.stringify({...o.source_payload,sourceShop:r.shop,...(r.channel==='shopify'&&o.cancelled?{cancelled:true}:{}),...(r.channel==='temu'?{temuLabelPurchaseConfirmationRequired:true}:{})}),initialMarketplaceHold(o),'pending',null,r.channel==='temu'?'temu':null]);
  for(const l of o.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[l.id,id,l.source_line,l.source_sku,l.quantity,JSON.stringify(l.source_payload)]);
  if(r.channel==='shopify')for(const kind of ['label','erp'])await tx.query('INSERT INTO jobs(id,order_id,kind) VALUES($1,$2,$3)',[randomUUID(),id,kind]);
  await tx.query('INSERT INTO marketplace_order_links(channel,shop,reference,order_id,version) VALUES($1,$2,$3,$4,$5)',[r.channel,r.shop,o.reference,id,o.version]);return {created:true,id};
 }));
}

export function marketplaceInbox(db){let running=false;return {get running(){return running;},async run(){if(running)return;running=true;try{for(let i=0;i<25;i++){const r=await db.transaction(async tx=>{const row=(await tx.query("SELECT * FROM marketplace_receipts WHERE status='pending' OR (status='review' AND updated_at<now()-interval '5 minutes') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!row)return null;await tx.query("UPDATE marketplace_receipts SET status='processing' WHERE id=$1",[row.id]);return row;});if(!r)break;try{await applyMarketplaceReceipt(db,r);await db.query("UPDATE marketplace_receipts SET status='complete',error=null,updated_at=now() WHERE id=$1",[r.id]);}catch(e){await db.query("UPDATE marketplace_receipts SET status='review',error=$2,updated_at=now() WHERE id=$1",[r.id,String(e.message).slice(0,500)]);}}}finally{running=false;}}};}
