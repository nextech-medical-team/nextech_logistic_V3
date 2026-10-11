import {lifecycleObservation} from './marketplace-content-freeze.mjs';
// No detail, address, product, line or logistics validation in source surveillance.
export async function readTemuLifecycle(api,order,{entry,shouldStop=()=>false,onProgress=async()=>{}}={}){
 const reference=order.source_reference||order.reference;if(!/^PO-\d+-\d+$/.test(reference||''))throw Error('Référence TEMU invalide');
 const read=async(type,args)=>{if(shouldStop())throw Object.assign(Error('Arrêt demandé'),{code:'TEMU_STOPPING'});await onProgress();return api.read(type,args,{shouldStop});};
 if(!entry){
  const created=Number(order.source_payload?.temuOrderDetail?.parentOrderMap?.parentOrderTime)||Math.floor(Date.parse(order.source_date)/1000);
  if(!Number.isSafeInteger(created)||created<=0)throw Error('TEMU · Date source requise pour lire annulation/remboursement');
  let total=null;const seen=new Set();for(let pageNumber=1;pageNumber<=1000;pageNumber++){
   const response=await read('bg.order.list.v2.get',{pageNumber,pageSize:50,updateAtStart:created-1,updateAtEnd:Math.floor(Date.now()/1000),sortby:'updateTime'});
   const count=Number(response.totalItemNum),items=response.pageItems;if(!Number.isSafeInteger(count)||count<0||!Array.isArray(items)||items.length>50||total!==null&&count!==total)throw Error('TEMU · Liste de statuts non vérifiable');total=count;
   for(const item of items){const ref=item.parentOrderMap?.parentOrderSn;if(!ref||seen.has(ref))throw Error('TEMU · Identité de liste incohérente');seen.add(ref);if(ref===reference)entry={parentOrderMap:item.parentOrderMap};}
   if(entry)break;if(pageNumber*50>=total)break;if(items.length!==50)throw Error('TEMU · Page de statuts manquante');
  }
 }
 if(!entry)throw Error('TEMU · Commande absente de la liste de statuts');
 const observation=lifecycleObservation('temu',{detail:{parentOrderMap:entry.parentOrderMap}},{reference});
 const errors=[];try{const raw=await read('bg.order.amount.query',{parentOrderSn:reference});const refund=lifecycleObservation('temu',{detail:{parentOrderMap:entry.parentOrderMap},amounts:{parentOrderMap:raw?.parentOrderMap}},{reference,checkedAt:observation.checkedAt});Object.assign(observation,refund);if(refund.refundStatus==='unknown')errors.push({field:'refund',message:'TEMU · État de remboursement non disponible'});}catch(e){if(shouldStop()||['TEMU_STOPPING','TEMU_LEASE_LOST','source_budget_deferred'].includes(e.code))throw e;errors.push({field:'refund',message:String(e.message).slice(0,450)});}
 return {...observation,provider:'TEMU',readOnly:true,message:'BC rempli : contenu figé. Annulation : '+(observation.cancelled?'oui':'non')+' ; remboursement : '+({none:'aucun',partial:'partiel',full:'total',unknown:'non vérifié'}[observation.refundStatus])+'.',complete:errors.length===0,coreComplete:true,errors};
}
