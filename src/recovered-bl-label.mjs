import {randomUUID} from 'node:crypto';
import {refreshErplainDocuments} from './erplain-documents-sync.mjs';
import {queueExistingBlLabel} from './existing-bl-label.mjs';
import {queueLabelFromBl} from './direct-label.mjs';
import {withShipmentLock} from './shipment-lock.mjs';

// Used by the explicit BC/BL recovery actions, never by background read-only previews.
export async function recoverDocumentsAndLabels(db,api,id,user,{refresh=refreshErplainDocuments,queue=queueExistingBlLabel,queuePrimary=queueLabelFromBl}={}){
 if(!user?.email)throw Error('Utilisateur requis pour récupérer les BL et leurs étiquettes');
 return withShipmentLock(async()=>{
  const result=await refresh(db,api,id);
  const labels=[],labelHolds=[];
  if(!result.notFound&&result.bc){
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
   for(const bl of result.bc.shipping_orders?.data||[]){
    if(!['pending','make_the_shipment','in_preparation','ready_to_ship'].includes(bl.status))continue;
    try{
     if(result.stockHolds?.length)throw Error('Rapprochement de stock requis avant génération : '+result.stockHolds.map(h=>h.message).join('; '));
     const queued=String(bl.id)===String(o?.erp_live?.bl?.id)
      ?await queuePrimary(db,id,user)
      :await queue(db,api,{id,blId:String(bl.id),requestId:randomUUID()},user);
     labels.push({blId:String(bl.id),bl:bl.label,...queued});
     if(queued.existing&&['review','failed','cancelled'].includes(queued.status))labelHolds.push({bl:bl.label,message:queued.error||'Demande existante à vérifier avant reprise'});
    }catch(error){labelHolds.push({bl:bl.label,message:error.message});}
   }
  }
  const created=labels.filter(l=>!l.existing).length;
  const message=[result.message,created?`${created} étiquette(s) de BL récupéré mise(s) en génération.`:'',labels.some(l=>l.existing)?'Les demandes d’étiquettes existantes sont conservées.':'',...labelHolds.map(h=>`${h.bl} : étiquette non déclenchée — ${h.message}`)].filter(Boolean).join(' ');
  return {...result,message,labels,labelHolds};
 });
}
