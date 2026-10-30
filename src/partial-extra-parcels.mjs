import {randomUUID} from 'node:crypto';
import {assertManualLabelOrder} from './manual-label-policy.mjs';
import {addressIssue} from './domain.mjs';

export function partialParcelShipment(order,delivery){
 if(!delivery||delivery.order_id!==order?.id||delivery.status!=='ready'||delivery.environment!=='production'||!delivery.bl?.id||!delivery.tracking?.length)throw Error('BL avec étiquettes PROD prêtes requis');
 if(!['gls','gls_pharma','gls_shop','gofo'].includes(delivery.carrier)||!Array.isArray(delivery.selection)||!delivery.selection.length)throw Error('Transporteur ou produits du BL absents');
 if(!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(delivery.bl.status))throw Error('BL annulé ou déjà expédié : ajout indisponible');
 const a=delivery.bl.shipping_address;
 const address=a?{name:a.label,street:[a.address_1,a.address_2].filter(Boolean).join(' '),street1:a.address_1,street2:a.address_2||'',postal:a.postal_code,city:a.city,country:a.country,phone:a.phone||order.address?.phone,email:order.address?.email}:order.address;
 const shipment={...order,partial_mode:false,address,carrier:delivery.carrier,transport_choice:delivery.carrier,label_bl:delivery.bl.label,label_bl_id:delivery.bl.id,associated_bl_label:true,duplicate_of:order.id,erp_live:{...order.erp_live,bl:delivery.bl},weight_kg:Math.ceil(Number(delivery.weight_kg)/Number(delivery.parcel_count)*1000)/1000,lines:delivery.selection.map(l=>({target_sku:l.sku,target_quantity:l.quantity}))};
 assertManualLabelOrder(shipment,delivery.carrier,{manualChoice:true});
 if(addressIssue(address))throw Error(addressIssue(address));
 if(!(shipment.weight_kg>0)||!Number.isFinite(shipment.weight_kg))throw Error('Poids du colis absent');
 return shipment;
}
export async function queuePartialParcels(db,b){
 if(typeof b.deliveryId!=='string'||!/^[a-f0-9-]{36}$/i.test(b.requestId||'')||!Number.isInteger(b.expectedTotal)||!Number.isInteger(b.total)||b.total<=b.expectedTotal||b.total>b.expectedTotal+100)throw Error('Nombre total invalide : ajouter de 1 à 100 étiquettes');
 return db.transaction(async tx=>{
  const d=(await tx.query('SELECT * FROM partial_deliveries WHERE id=$1 FOR UPDATE',[b.deliveryId])).rows[0];
  if(!d)throw Error('Livraison introuvable');
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[d.order_id])).rows[0];partialParcelShipment(o,d);
  const prior=(await tx.query('SELECT * FROM extra_parcels WHERE request_id=$1',[b.requestId])).rows[0];
  if(prior){if(prior.delivery_id!==d.id||prior.parcel_total!==b.total||prior.parcel_index!==b.expectedTotal+1)throw Error('Demande déjà utilisée');return {id:prior.id,total:b.total};}
  const extras=(await tx.query("SELECT * FROM extra_parcels WHERE delivery_id=$1 AND status NOT IN ('failed','cancelled')",[d.id])).rows;
  if(extras.some(p=>p.status!=='ready'))throw Error('Création en cours ou incertaine : vérifier avant ajout');
  const docs=(await tx.query('SELECT count(*)::int n FROM partial_documents WHERE delivery_id=$1',[d.id])).rows[0].n;
  const current=Math.max(d.tracking.length,docs)+extras.length;
  if(current!==b.expectedTotal)throw Error('Le nombre a changé : actualiser avant modification');
  const ids=[];for(let i=current+1;i<=b.total;i++){const id=randomUUID();ids.push(id);await tx.query('INSERT INTO extra_parcels(id,order_id,delivery_id,request_id,carrier,environment,parcel_index,parcel_total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,o.id,d.id,i===current+1?b.requestId:b.requestId+':'+i,d.carrier,'production',i,b.total]);}
  return {id:ids[0],ids,total:b.total};
 });
}
