import {erplainAccount} from './erplain-accounts.mjs';
import {applyBlIdentityObservation} from './bl-identity.mjs';
export function erplainStatusSync(db,directory,{apiFactory=()=>erplainAccount(directory,'live')}={}){
 let running=false;
 return {async refresh(){
  if(running)throw Error('Actualisation Erplain déjà en cours');running=true;
  try{
   const api=apiFactory();await api.verify();
   const rows=(await db.query("SELECT id,erp_live FROM orders WHERE erp_live->'bc'->>'id' IS NOT NULL")).rows;
   let done=0,changedDuringRead=0,identityIssues=0;
   for(let start=0;start<rows.length;start+=10){
    const batch=rows.slice(start,start+10).filter(o=>/^\d+$/.test(String(o.erp_live.bc.id))&&(!o.erp_live.bl?.id||/^\d+$/.test(String(o.erp_live.bl.id))));
    if(!batch.length)continue;
    const fields=batch.map((o,i)=>'b'+i+':Order(id:'+Number(o.erp_live.bc.id)+'){id label status shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}}'+(o.erp_live.bl?.id?' s'+i+':ShippingOrder(id:'+Number(o.erp_live.bl.id)+'){id label status}':''));
    const data=await api.request('query V3DocumentStatuses {'+fields.join(' ')+'}');
    for(let i=0;i<batch.length;i++){
     const o=batch[i],bc=data['b'+i];
     if(!bc)throw Error('BC Erplain introuvable : aucune référence BL remplacée');
     const bl=o.erp_live.bl?.id?data['s'+i]:null;
     const next=applyBlIdentityObservation(o.erp_live,bc,bl);
     const result=await db.query('UPDATE orders SET erp_live=$2 WHERE id=$1 AND erp_live=$3::jsonb RETURNING id',[o.id,JSON.stringify(next),JSON.stringify(o.erp_live)]);
     if(!result.rows.length){changedDuringRead++;continue;}
     done++;if(['missing','detached'].includes(next.blIdentity.status))identityIssues++;
    }
   }
   return {message:done+' commandes actualisées depuis Erplain LIVE, sans création de BC/BL.',done,changedDuringRead,identityIssues};
  }finally{running=false;}
 }};
}
