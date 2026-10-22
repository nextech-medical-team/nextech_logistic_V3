import {hasPartialCreatedBl} from './created-bl-label.mjs';
import {suspensionBlock} from './order-suspension.mjs';
export const partialPhonePreflight='Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS';
const positive=v=>Number.isFinite(Number(v))&&Number(v)>0;
export function partialLabelWeight(d,o,weights){
 let weight=0,missing='';for(const l of d.selection){const w=weights.find(p=>p.sku===l.sku);if(!positive(w?.weight_kg)||!positive(l.quantity)){missing=l.sku;break;}weight+=Number(w.weight_kg)*Number(l.quantity);}
 if(!missing&&positive(weight))return {weight,source:'selected_products'};
 if(hasPartialCreatedBl(d)&&d.label_choice!=='existing_bl'){
  if(positive(d.weight_kg))return {weight:Number(d.weight_kg),source:'saved_delivery'};
  if(positive(o.weight_kg))return {weight:Number(o.weight_kg),source:'saved_order_estimate'};
 }
 throw Error('Poids absent pour la livraison partielle : '+missing);
}
export async function retryPartialLabel(db,id){
 return db.transaction(async tx=>{
  const d=(await tx.query('SELECT * FROM partial_deliveries WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!d)throw Error('Livraison introuvable');if(d.label_choice==='bl_only_temu')throw Error('TEMU · BL uniquement : aucune création ou reprise d’étiquette autorisée');
  if(['bl_ready','finalizing_bl','awaiting_pdf','creating_label','ready'].includes(d.status))return {existing:true,status:d.status,blId:d.bl?.id};
  if(d.status!=='review')throw Error('Création incertaine : rapprochement requis, aucun nouvel envoi automatique');
  if(d.carrier_result!==null&&d.carrier_result!==undefined){await tx.query("UPDATE partial_deliveries SET status='awaiting_pdf',error=null WHERE id=$1",[id]);return {recoveryOnly:true,originalError:d.error,blId:d.bl?.id};}
  const docs=(await tx.query('SELECT 1 FROM partial_documents WHERE delivery_id=$1 LIMIT 1',[id])).rows;
  if(docs.length||d.tracking?.length||d.environment!=='production'||!hasPartialCreatedBl(d)||!(['bl_ready','finalizing_bl','recovered_bl'].includes(d.stage)||d.stage==='creating_label'&&d.error===partialPhonePreflight))throw Error('Création incertaine : rapprochement requis, aucun nouvel envoi automatique');
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[d.order_id])).rows[0];
  if(!o||suspensionBlock(o)||o.archived||o.erp_live?.bc?.status==='cancelled'||(d.label_choice==='existing_bl'?o.tracking_status==='cancelled':['cancelled','shipped','delivered','in_transit'].includes(o.tracking_status)))throw Error('Expédition suspendue, annulée ou déjà expédiée');
  await tx.query("UPDATE partial_deliveries SET status='bl_ready',error=null WHERE id=$1",[id]);
  return {originalError:d.error,blId:d.bl.id,labelOnly:true};
 });
}
