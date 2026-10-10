import {withShipmentLock} from './shipment-lock.mjs';
const historical=label=>/^SHO[0-9]{8}$/.test(label||'');
export function assertHistoricalBlNumber(bl){if(!historical(bl?.label))throw Error('BL · Numéro Erplain historique non confirmé');return bl;}
export async function publishHistoricalBl(api,id,metadata={}){
 return withShipmentLock(async()=>{
 let collided=false;
 for(let attempt=0;attempt<5;attempt++){
  const {ShippingOrder:current}=await api.request('query V3BlBeforeNumber($id:ID!){ShippingOrder(id:$id){id label status}}',{id:String(id)});
  if(String(current?.id)!==String(id))throw Error('BL introuvable : numérotation interrompue');
  if(!['unpublished','pending','ready_to_ship'].includes(current.status))throw Error('BL clôturé ou expédié : rapprochement requis avant numérotation');
  if(current.status!=='unpublished'&&historical(current.label))return current;
  let label=current.label;
  if(!historical(label)||collided){
   const {ShippingOrders:history}=await api.request('query V3HistoricalBlNumber {ShippingOrders(first:1,where:{column:LABEL,operator:LIKE,value:"SHO________"},orderBy:[{column:LABEL,order:DESC}]){data{id label}}}');
   const last=history?.data?.[0]?.label;
   if(!historical(last))throw Error('BL · Séquence historique Erplain non vérifiable');
   const number=Number(last.slice(3))+1;if(number>99999999)throw Error('BL · Capacité de numérotation dépassée');
   label='SHO'+String(number).padStart(8,'0');
  }
  const status=current.status==='unpublished'?'pending':current.status;
  const input=current.status==='unpublished'?{...metadata,label,status}:{label};
  try{
   const {UpdateShippingOrder:updated}=await api.request('mutation V3PublishHistoricalBL($id:ID!,$input:ShippingOrderInput!){UpdateShippingOrder(id:$id,input:$input){id label status}}',{id:String(id),input});
   if(String(updated?.id)!==String(id)||updated.label!==label||updated.status!==status)throw Error('BL · Publication ou numéro non confirmé');
  }catch(e){if(/label.*already in use/i.test(e.message)&&attempt<4){collided=true;continue;}throw e;}
  const {ShippingOrder:verified}=await api.request('query V3VerifyHistoricalBL($id:ID!){ShippingOrder(id:$id){id label status}}',{id:String(id)});
  if(String(verified?.id)!==String(id)||verified.label!==label||verified.status!==status)throw Error('BL · Numéro ou statut différent à la relecture');
  return assertHistoricalBlNumber(verified);
 }
 throw Error('BL · Numérotation occupée');
 },['erplain-bl-numbering']);
}
