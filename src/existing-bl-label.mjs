import {randomUUID,createHash} from 'node:crypto';
import {readErplainDocuments,assertDocumentIdle} from './erplain-document-read.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

export function existingBlShipment(o,bc,blId){
 const blocked=suspensionBlock(o);if(blocked)throw Error(blocked);
 if(o?.source_payload?.erplainValidationHold&&o.source_payload.erplainValidation!=='approved')throw Error('Commande Erplain en attente de validation manuelle');
 if(!o||o.archived||o.tracking_status==='cancelled'||['temu','relay'].includes(o.channel))throw Error('Commande indisponible pour une étiquette de BL associé');
 if(String(o.erp_live?.bl?.id)===String(blId))throw Error('BL principal : utiliser son parcours d’étiquette existant');
 if(String(bc?.id)!==String(o.erp_live?.bc?.id)||bc.status!=='active')throw Error('BC actif non confirmé');
 const matches=(bc.shipping_orders?.data||[]).filter(b=>String(b.id)===String(blId));
 if(matches.length!==1||!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(matches[0].status))throw Error('BL absent, annulé ou déjà expédié');
 const bl=matches[0];if(!bl.label)throw Error('Numéro du BL absent');
 // An existing BL supplies the shipment contents; BC allocation is not a label prerequisite.
 if(!Array.isArray(bl.line_items))throw Error('Lignes du BL non reçues');
 const selection=bl.line_items.filter(item=>item.variant).map(item=>({lineId:String(item.parent_id||item.id||''),variantId:String(item.variant.id),locationId:String(item.location?.id||''),sku:item.variant.sku||'',quantity:Number(item.quantity),price:Number(item.price),tracked:item.variant.track_inventory!==false}));
 const a=bl.shipping_address||bc.shipping_address;
 if(!a||!['label','address_1','postal_code','city','country'].every(k=>String(a[k]||'').trim()))throw Error('Adresse du BL à compléter dans Erplain');
 const address={name:a.label,street:[a.address_1,a.address_2].filter(Boolean).join(' '),street1:a.address_1,street2:a.address_2||'',city:a.city,postal:a.postal_code,country:a.country,phone:a.phone||o.address?.phone||'',email:o.address?.email||''};
 const fingerprint=createHash('sha256').update(JSON.stringify({bcId:String(bc.id),blId:String(bl.id),label:bl.label,selection,address})).digest('hex');
 return {bl,selection,address,fingerprint};
}

export async function readExistingBlShipment(db,api,o,blId){
 await assertDocumentIdle(db,o.id);
 await api.verify();return existingBlShipment(o,await readErplainDocuments(api,o.erp_live?.bc?.id),blId);
}

// A separate carrier shipment for an existing BL. No Erplain or stock mutation.
export async function queueExistingBlLabel(db,api,{id,blId,requestId},user){
 if(typeof id!=='string'||typeof blId!=='string'||!blId||!/^[a-f0-9-]{36}$/i.test(requestId||'')||!user?.email)throw Error('Commande, BL et identifiant de demande requis');
 return withShipmentLock(async()=>{
  const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
  if(!o)throw Error('Commande introuvable');
  const previous=(await db.query('SELECT * FROM partial_deliveries WHERE request_id=$1 OR bl->>\'id\'=$2',[requestId,blId])).rows;
  let recovered=null;
  if(previous.length){
   if(previous.length!==1||previous[0].order_id!==id||String(previous[0].bl?.id)!==blId)throw Error('Demande ou BL déjà associé à une autre livraison');
   const d=previous[0];
   if(d.status==='review'&&d.stage==='recovered_bl'&&d.request_id.startsWith('recovered-bl:')&&!d.carrier_result&&!d.tracking?.length)recovered=d;
   else return {id:d.id,status:d.status,existing:true,...(d.error?{error:d.error}:{})};
  }
  await assertDocumentIdle(db,id);
  const shipment=await readExistingBlShipment(db,api,o,blId);
  return db.transaction(async tx=>{
   const fresh=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(JSON.stringify(fresh)!==JSON.stringify(o))throw Error('Commande modifiée pendant la lecture : relancer');
   await assertDocumentIdle(tx,id);
   if((await tx.query("SELECT 1 FROM orders WHERE id<>$1 AND erp_live->'bl'->>'id'=$2",[id,blId])).rows.length)throw Error('BL déjà utilisé par une autre commande');
   if((await tx.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','review') UNION ALL SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status IN ('pending','processing')",[id])).rows.length)throw Error('Traitement en cours ou incertain : rapprocher avant un nouvel envoi');
   const deliveryId=recovered?.id||randomUUID(),bl={...shipment.bl,labelRequest:{fingerprint:shipment.fingerprint,requestedBy:user.email}};
   if(recovered){
    const current=(await tx.query('SELECT * FROM partial_deliveries WHERE id=$1 FOR UPDATE',[deliveryId])).rows[0];
    if(JSON.stringify(current)!==JSON.stringify(recovered)||(await tx.query('SELECT 1 FROM partial_documents WHERE delivery_id=$1 LIMIT 1',[deliveryId])).rows.length)throw Error('Livraison récupérée modifiée ou étiquette existante : rapprocher avant lancement');
    await tx.query("UPDATE partial_deliveries SET status='bl_ready',stage='bl_ready',selection=$2,bl=$3,label_choice='existing_bl',environment='production',error=null,updated_at=now() WHERE id=$1",[deliveryId,JSON.stringify(shipment.selection),JSON.stringify(bl)]);
   }else await tx.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,stage,selection,bl,label_choice,environment) VALUES($1,$2,$3,'bl_ready','bl_ready',$4,$5,'existing_bl','production')",[deliveryId,id,requestId,JSON.stringify(shipment.selection),JSON.stringify(bl)]);
   await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'label.existing_associated_bl',$2)",[user.email,JSON.stringify({orderId:id,deliveryId,bcId:o.erp_live.bc.id,blId,blLabel:shipment.bl.label})]);
   return {id:deliveryId,status:'bl_ready',existing:false};
  });
 });
}
