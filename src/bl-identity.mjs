const id=value=>String(value??'');
const published=bl=>bl?.id&&bl.status!=='unpublished';
// A number is a display attribute, never proof that two documents are identical.
export function observeBlIdentity(state,bc,bl,{now=Date.now()}={}){
 if(!state?.bc?.id||id(bc?.id)!==id(state.bc.id)||!bc.label||!bc.status||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false)throw Error('Identité BL : lecture du BC incomplète');
 const related=bc.shipping_orders.data;
 if(related.some(b=>!b?.id||!b.status)||new Set(related.map(b=>id(b.id))).size!==related.length)throw Error('Identité BL : livraisons incohérentes');
 if(bl===undefined)throw Error('Identité BL : réponse absente, aucune conclusion');
 if(bl!==null&&id(bl.id)!==id(state.bl?.id))throw Error('Identité BL : identifiant de réponse différent');
 if(bl!==null&&(!bl.label||!bl.status))throw Error('Identité BL : document incomplet');
 const linked=related.find(b=>id(b.id)===id(state.bl?.id));
 if(bl===null&&linked)throw Error('Identité BL : lectures contradictoires, aucune conclusion');
 const status=!state.bl?.id?'none':bl===null?'missing':bl.status==='unpublished'?'draft':!linked?'detached':'verified';
 if(linked&&bl&&(linked.label!==bl.label||linked.status!==bl.status))throw Error('Identité BL : document modifié pendant la lecture');
 return {checkedAt:new Date(now).toISOString(),bcId:id(bc.id),blId:id(state.bl?.id),status,previousBl:state.bl?structuredClone(state.bl):null,observedBl:bl,shippingOrders:related};
}
export function matchingBlIdentity(state){
 const proof=state?.blIdentity;
 const observed=proof&&['verified','draft'].includes(proof.status)?proof.observedBl:proof?.previousBl;
 return proof&&id(proof.bcId)===id(state.bc?.id)&&id(proof.blId)===id(state.bl?.id)&&observed?.status===state.bl?.status&&observed?.label===state.bl?.label?proof:null;
}
export function visibleOrderBls(order,partialBls=[]){
 if(order.partial_mode)return partialBls.filter(published);
 const state=order.erp_live||{},proof=matchingBlIdentity(state);
 if(proof)return proof.shippingOrders.filter(published);
 const associated=state.documentSource?.shippingOrders;
 if(associated?.length)return associated.filter(published);
 return published(state.bl)?[state.bl]:[];
}
export function applyBlIdentityObservation(state,bc,bl,options){
 const proof=observeBlIdentity(state,bc,bl,options);
 // A status-only read must not erase already saved BL lines, addresses or
 // stock flags used by PDF recovery. Enrichment is strictly by immutable ID.
 const metadata=new Map();
 for(const saved of [...(state.bc?.shipping_orders?.data||[]),...(state.documentSource?.shippingOrders||[]),...(state.bl?[state.bl]:[])])if(saved?.id)metadata.set(id(saved.id),{...metadata.get(id(saved.id)),...saved});
 const shippingOrders=proof.shippingOrders.map(current=>({...metadata.get(id(current.id)),...current}));
 return {...state,bc:{...state.bc,id:bc.id,label:bc.label,status:bc.status},
  ...(bl&&['verified','draft'].includes(proof.status)?{bl:{...state.bl,...bl}}:{}),
  blIdentity:proof,status_checked_at:proof.checkedAt,
  documentSource:{...state.documentSource,shippingOrders,identityCheckedAt:proof.checkedAt}};
}
