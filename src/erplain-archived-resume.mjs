import {randomUUID} from 'node:crypto';
import {syncedSelection} from './partial-erplain-sync.mjs';
import {assertDocumentIdle} from './erplain-document-read.mjs';
import {suspensionBlock} from './order-suspension.mjs';
export function archivedResumeBlock(o){
 if(!o?.archived)return 'Commande non archivée';
 if(!['amazon','shopify','erplain'].includes(o.channel))return 'Reprise de ce circuit non disponible ici';
 if(o.source_payload?.importCancellation?.scope!=='import_only_not_marketplace'||o.source_payload.importCancellation.status!=='cancelled')return 'Origine de l’archivage à vérifier avant réactivation';
 if(suspensionBlock(o)||o.source_payload?.manualPlatformCancellation?.cancelled||o.source_payload?.platformCancelled||o.source_payload?.erplainValidationHold)return 'Suspension ou annulation métier à résoudre avant réactivation';
 return null;
}
export async function resumeArchivedBl(tx,o,bc,blId,user){
 const requestKey='recovered-bl:'+o.id+':'+String(blId);
 const prior=(await tx.query('SELECT * FROM partial_deliveries WHERE request_id=$1',[requestKey])).rows[0];
 if(prior){if(prior.order_id!==o.id||String(prior.bl?.id)!==String(blId))throw Error('Identité de reprise différente');return {orderId:o.id,deliveryId:prior.id,replayed:true,archived:!!o.archived};}
 const blocked=archivedResumeBlock(o);if(blocked)throw Error(blocked);
 if(String(o.erp_live?.bc?.id)!==String(bc.id)||bc.status!=='active')throw Error('BC actif déjà rattaché requis');
 const bls=bc.shipping_orders?.data;if(!Array.isArray(bls)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Lecture des BL incomplète');
 const selected=bls.filter(b=>String(b.id)===String(blId));if(selected.length!==1||selected[0].status!=='pending'||!selected[0].label)throw Error('Choisir un BL existant encore en attente (pending)');
 await assertDocumentIdle(tx,o.id);
 const busy=(await tx.query("SELECT 1 FROM erp_live_jobs WHERE order_id=$1 AND status='pending' UNION ALL SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('pending','creating','awaiting_pdf','review') UNION ALL SELECT 1 FROM partial_deliveries WHERE order_id=$1 AND status NOT IN ('ready','cancelled')",[o.id])).rows;
 if(busy.length)throw Error('Traitement actif ou incertain : vérifier avant réactivation');
 const duplicate=(await tx.query("SELECT 1 FROM partial_deliveries WHERE bl->>'id'=$1",[String(blId)])).rows;
 if(duplicate.length||String(o.erp_live?.bl?.id)===String(blId))throw Error('Ce BL possède déjà un traitement : utiliser sa reprise existante');
 const bl=selected[0],selection=syncedSelection(bc,bl);
 if(!selection.length||selection.some(l=>!(l.quantity>0)||!l.sku||!l.locationId||!Number.isFinite(l.price)||l.price<0))throw Error('Articles ou quantités du BL incomplets');
 const at=new Date().toISOString(),deliveryId=randomUUID();
 // Published BL: never enter the stages that create a BL or debit stock.
 // A separate human action starts the label step; reads cannot auto-resume it.
 await tx.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,stage,selection,bl,label_choice,environment,error) VALUES($1,$2,$3,'review','recovered_bl',$4,$5,'new','production',$6)",[deliveryId,o.id,requestKey,JSON.stringify(selection),JSON.stringify(bl),'BL existant récupéré : lancement de l’étiquette à confirmer']);
 const recovery={at,by:user.email,blId:String(blId),deliveryId,previous:{archived:o.archived,tracking_status:o.tracking_status,label_status:o.label_status,erp_status:o.erp_status},importCancellation:o.source_payload.importCancellation};
 const state={...o.erp_live,bc:{...o.erp_live.bc,...bc},documentSource:{...o.erp_live.documentSource,shippingOrders:bls,checkedAt:at}};
 await tx.query("UPDATE orders SET archived=false,partial_mode=true,tracking_status='not_shipped',label_status='partial',erp_status='partial_pending',resolution_pending_resume=true,erp_live=$2,source_payload=source_payload||$3::jsonb WHERE id=$1",[o.id,JSON.stringify(state),JSON.stringify({archivedBlRecovery:recovery})]);
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'erplain.archived_bl_reactivated',$2)",[user.email,JSON.stringify({orderId:o.id,bcId:String(bc.id),...recovery})]);
 return {orderId:o.id,deliveryId,archived:false,blId:String(blId),labelPurchased:false,message:'Commande réactivée. BL existant récupéré ; lancement de l’étiquette à confirmer dans la livraison partielle.'};
}
