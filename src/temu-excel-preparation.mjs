import {verifyExcelTemuDetail} from './temu-excel-identity.mjs';
import {randomUUID} from 'node:crypto';
import {isTemuExcel,excelCommercialSource} from './temu-excel-commercial.mjs';
import {withShipmentLock} from './shipment-lock.mjs';
import {inspectTemu,readTemuShipments,hash} from './temu-shipping.mjs';
export const excelImportHold='Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation.';
export const excelPreparationFingerprint=(o,lines)=>hash({reference:o.reference,address:o.address,recipient:o.recipient,source:o.source_payload,suspension:o.suspension,lines});
export function temuExcelPreparation(db,local){
 async function read(reference,tx=db){
  const o=(await tx.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];
  if(!isTemuExcel(o)||o.archived)throw Error('Commande Excel TEMU active requise');
  const lines=(await tx.query('SELECT * FROM lines WHERE order_id=$1 ORDER BY source_line,id',[o.id])).rows;
  return {o,lines};
 }
 return {
  async list(){return {rows:(await db.query(`SELECT o.id,o.reference,o.recipient,o.address->>'country' country,o.suspension,o.issue,o.erp_live,o.source_payload->'temuExcelPreparation' preparation,e.status erp_status,e.error erp_error,
   (SELECT json_build_object('status',r.status,'error',r.error,'stage',r.stage) FROM resolution_jobs r WHERE r.order_id=o.id ORDER BY r.created_at DESC LIMIT 1) resolution
   FROM orders o LEFT JOIN erp_live_jobs e ON e.order_id=o.id WHERE o.channel='temu' AND o.source_payload->>'origin'='temu_excel' AND NOT o.archived ORDER BY o.source_date DESC,o.reference`)).rows};},
  async preview(reference){
   const {o,lines}=await read(reference),commercial=excelCommercialSource(o,lines);
   return {reference,fingerprint:o.source_payload.temuExcelPreparation?.fingerprint||excelPreparationFingerprint(o,lines),commercial,lines:lines.map(l=>({sku:l.source_sku,quantity:Number(l.quantity)}))};
  },
  async prepare({reference,fingerprint,confirmPreparation},user){
   if(!['admin','manager'].includes(user?.role))throw Object.assign(Error('Droits de préparation requis'),{status:403});
   if(confirmPreparation!==true||typeof fingerprint!=='string')throw Error('Confirmez la préparation des BC/BL');
   const initial=await read(reference);
   return withShipmentLock(async()=>{
    const {o,lines}=await read(reference);
    if(o.source_payload.temuExcelPreparation){
     if(o.source_payload.temuExcelPreparation.fingerprint===fingerprint)return {id:o.id,replayed:true,message:'Préparation déjà demandée. Consultez son avancement.'};
     throw Error('Commande déjà raccordée : utilisez les corrections de la commande existante');
    }
    if(excelPreparationFingerprint(o,lines)!==fingerprint)throw Error('Commande modifiée : relancez la vérification');
    if(o.issue&&o.issue!==excelImportHold||o.suspension?.active!==true||o.suspension.note!==excelImportHold||Object.hasOwn(o.suspension,'erplainCancellation')||o.source_payload.marketplacePendingCorrection||o.transport_choice||o.partial_mode||o.erp_live?.bc||o.erp_live?.customer||o.erp_live?.phase||o.tracking_status!=='not_shipped')throw Error('Blocage ou préparation existante : vérifier la commande avant raccordement');
    const commercial=excelCommercialSource(o,lines),{mallId,api,detail}=await local.resolveExcelShop(o,lines);
    verifyExcelTemuDetail(o,lines,detail);
    const info=inspectTemu(detail,reference);
    if(![1,2].includes(info.status)||info.packages.length||(detail.orderList||[]).some(l=>[3,4,5].includes(Number(l.orderStatus))||Number(l.canceledQuantityBeforeShipment)>0||[true,1,'1'].includes(l.isCancelledDuringPending)))throw Error('Commande TEMU annulée ou déjà expédiée : rapprochement requis');
    if((await readTemuShipments(api,reference,detail)).shipmentInfoDTO.length)throw Error('Une expédition TEMU existe déjà : rapprocher la commande existante dans TEMU');
    return db.transaction(async tx=>{
     await tx.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[o.id]);
     const current=await read(reference,tx);
     if(excelPreparationFingerprint(current.o,current.lines)!==fingerprint)throw Error('Commande modifiée pendant la vérification');
     const busy=(await tx.query(`SELECT 1 FROM erp_live_jobs WHERE order_id=$1 UNION ALL SELECT 1 FROM resolution_jobs WHERE order_id=$1 AND status IN ('queued','running','waiting') UNION ALL SELECT 1 FROM temu_label_jobs WHERE reference=$2 AND (attempt_id IS NOT NULL OR jsonb_array_length(packages)>0)`,[o.id,reference])).rows;
     if(busy.length)throw Error('Traitement existant à rapprocher avant raccordement');
     const at=new Date().toISOString(),jobId=randomUUID(),state={...o.suspension,active:false,note:'Import Excel TEMU vérifié ; préparation demandée.',version:randomUUID(),updatedAt:at,updatedBy:user.email};
     const payload={...(commercial.company?{company:commercial.company,client:commercial.company}:{}),mallId,sourceShop:mallId,currency:commercial.currency,temuExcelCommercial:commercial,manualPreparationRequired:false,manualLabelPurchaseRequired:false,temuExcelPreparation:{fingerprint,mallId,at,user:user.email,jobId},temuOrderDetail:detail,temuDirect:{source:'temu_direct',state:'verified',verifiedAt:at,status:info.status}};
     await tx.query('UPDATE orders SET source_payload=source_payload||$2::jsonb,suspension=$3,issue=null WHERE id=$1',[o.id,JSON.stringify(payload),JSON.stringify(state)]);
     const request={id:o.id,requestId:jobId,action:'resume',type:'resolved'};
     await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload) VALUES($1,$2,$1,'resume',$3)",[jobId,o.id,JSON.stringify(request)]);
     await tx.query("INSERT INTO order_suspension_events(id,order_id,action,user_email,note,state) VALUES($1,$2,'reactivated',$3,$4,$5)",[randomUUID(),o.id,user.email,state.note,JSON.stringify(state)]);
     await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'temu.excel.preparation.requested',$2)",[user.email,JSON.stringify({orderId:o.id,mallId,jobId,fingerprint})]);
     return {id:o.id,jobId,message:'Préparation BC/BL demandée dans Erplain. L’étiquette sera achetée automatiquement si les contrôles et la marge le permettent.'};
    });
   },['stock-mutations','temu-order:'+reference,'suspension:'+initial.o.id]);
  }
 };
}
