import {randomUUID} from 'node:crypto';
import {withShipmentLock} from './shipment-lock.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {pdfBytes} from './carriers-test.mjs';

export async function initializePartialParcelCount(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS partial_parcel_requests(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES partial_deliveries(id),expected_total INT NOT NULL,target_total INT NOT NULL,status TEXT NOT NULL,result JSONB,error TEXT,created_at TIMESTAMPTZ DEFAULT now());`);
}

export function partialParcelPlan(d,{expectedTotal,total}){
 if(d?.status!=='ready'||d.environment!=='production'||!['gls','gls_pharma','gls_shop','gofo'].includes(d.carrier))throw Error('Une livraison partielle prête avec étiquette PROD est requise');
 const current=d.tracking?.length;
 if(!Number.isInteger(expectedTotal)||expectedTotal!==current||d.parcel_count!==current)throw Error('Le nombre de colis a changé : actualiser la livraison');
 if(!Number.isInteger(total)||total<=current||total>current+10||total>100)throw Error('Ajouter entre 1 et 10 étiquettes. Une réduction nécessite le remplacement des étiquettes existantes.');
 if(!Number.isFinite(Number(d.weight_kg))||Number(d.weight_kg)<=0)throw Error('Poids de la livraison non vérifié');
 return {current,total,count:total-current};
}

// Each carrier result is durably recorded before attaching it. Any interrupted
// request blocks a new purchase, including a retry with a different request id.
export async function increasePartialParcels(db,api,client,routing,b,user){
 if(!/^[a-f0-9-]{36}$/i.test(b.requestId||''))throw Error('Identifiant de demande requis');
 return withShipmentLock(async()=>{
  const prior=(await db.query('SELECT * FROM partial_parcel_requests WHERE id=$1',[b.requestId])).rows[0];
  if(prior){
   if(prior.delivery_id!==b.id||prior.expected_total!==b.expectedTotal||prior.target_total!==b.total)throw Error('Demande déjà utilisée');
   if(prior.status==='complete')return {total:prior.target_total,replayed:true};
   throw Error('Création déjà demandée : résultat transporteur à rapprocher avant toute reprise');
  }
  const d=(await db.query('SELECT * FROM partial_deliveries WHERE id=$1',[b.id])).rows[0];
  const plan=partialParcelPlan(d,b);
  const o=(await db.query('SELECT * FROM orders WHERE id=$1',[d.order_id])).rows[0];
  if(!o||o.archived||suspensionBlock(o)||['shipped','delivered','in_transit','cancelled'].includes(o.tracking_status)||o.channel==='temu')throw Error('Livraison indisponible pour une étiquette supplémentaire');
  if((await db.query("SELECT 1 FROM partial_parcel_requests WHERE delivery_id=$1 AND status<>'complete'",[d.id])).rows.length)throw Error('Création précédente à rapprocher');
  if((await db.query("SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting')",[o.id])).rows.length)throw Error('Intervention en cours sur cette commande');
  const docs=(await db.query('SELECT document_index FROM partial_documents WHERE delivery_id=$1 ORDER BY document_index',[d.id])).rows;
  if(docs.length!==plan.current||docs.some((x,i)=>x.document_index!==i))throw Error('Documents existants incomplets : rapprochement requis');
  if(d.carrier.startsWith('gls')&&Number(d.weight_kg)>routing.maxParcelKg)throw Error('Poids supérieur au maximum GLS : vérifier le poids du colis supplémentaire');
  await api.verify();
  const live=(await api.request('query V3AdditionalPartialLabel($id:ID!){ShippingOrder(id:$id){id status update_stock line_items{quantity variant{id}} shipping_address{label address_1 address_2 city postal_code country} orders(first:10){data{id update_stock}}}}',{id:String(d.bl.id)})).ShippingOrder;
  const key=lines=>JSON.stringify(lines.map(l=>[String(l.variant?.id??l.variantId),Number(l.quantity)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const parent=live?.orders?.data;
  if(parent?.length!==1||String(parent[0].id)!==String(o.erp_live?.bc?.id))throw Error('BC du BL non confirmé');
  if(d.stock_document?.notRequired===true&&(parent[0].update_stock!==true||String(d.stock_document.bcId)!==String(parent[0].id)))throw Error('Débit du BC non confirmé');
  if(!live||live.status!=='ready_to_ship'||key(live.line_items)!==key(d.selection)||!d.stock_document||(!live.update_stock&&!d.stock_document.notRequired&&d.stock_document.status!=='completed'))throw Error('BL ou stock modifié : rapprocher la livraison avant ajout');
  const a=live.shipping_address;
  if(!a)throw Error('Adresse du BL absente');
  const shipment={...o,address:{...o.address,name:a.label,street:a.address_1,street2:a.address_2||'',city:a.city,postal:a.postal_code,country:a.country},recipient:a.label,label_bl:d.bl.label,label_bl_id:d.bl.id,carrier:d.carrier,weight_kg:Number(d.weight_kg),parcel_count:1,parcel_total:plan.total,glsInternational:routing.international,lines:d.selection.map(l=>({target_sku:l.sku,target_quantity:l.quantity}))};
  await db.query("INSERT INTO partial_parcel_requests(id,delivery_id,expected_total,target_total,status,result) VALUES($1,$2,$3,$4,'creating','[]')",[b.requestId,d.id,plan.current,plan.total]);
  const results=[];
  try{
   for(let i=plan.current;i<plan.total;i++){
    const order={...shipment,id:randomUUID(),duplicate_of:o.id,parcel_index:i+1};
    const result=d.carrier==='gofo'?await client.gofoCreate(order):await client.gls(order);
    results.push(result);
    await db.query('UPDATE partial_parcel_requests SET result=$2 WHERE id=$1',[b.requestId,JSON.stringify(results)]);
    if(result.tracking?.length!==1)throw Error('Suivi du nouveau colis non confirmé');
    const pdf=pdfBytes(d.carrier==='gofo'?await client.gofoLabel(result.reference):result.documents?.[0]);
    await db.transaction(async tx=>{
     const current=(await tx.query('SELECT tracking,status FROM partial_deliveries WHERE id=$1 FOR UPDATE',[d.id])).rows[0];
     if(current.status!=='ready'||current.tracking.length!==i)throw Error('Livraison modifiée pendant la création : résultat conservé');
     await tx.query('INSERT INTO partial_documents(delivery_id,document_index,pdf) VALUES($1,$2,$3)',[d.id,i,pdf]);
     await tx.query('UPDATE partial_deliveries SET tracking=$2,parcel_count=$3,updated_at=now() WHERE id=$1',[d.id,JSON.stringify([...current.tracking,...result.tracking]),i+1]);
    });
   }
   await db.transaction(async tx=>{
    await tx.query("UPDATE partial_parcel_requests SET status='complete' WHERE id=$1",[b.requestId]);
    await tx.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,'partial.parcels.added',JSON.stringify({deliveryId:d.id,requestId:b.requestId,before:plan.current,total:plan.total})]);
   });
   return {total:plan.total};
  }catch(e){await db.query("UPDATE partial_parcel_requests SET status='review',error=$2 WHERE id=$1",[b.requestId,e.message]);throw e;}
 });
}
