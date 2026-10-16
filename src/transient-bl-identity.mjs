// Drafts can be absent from Order.shipping_orders. Resolve their immutable ID
// and reverse BC relation before declaring a missing or different document.
export async function readTransientBlIdentity(reader,state,bc,{lookupDraft=true}={}){
 const list=bc.shipping_orders;let bl=list.data[0];
 if(bl&&(!bl.id||['cancelled','closed'].includes(bl.status)))throw Error('BL annulé ou non identifiable : contrôle nécessaire');
 if(lookupDraft&&state.bl?.id&&!bl&&state.bl.status==='unpublished'){
  const {ShippingOrder:draft}=await reader.request('query V3TransientSavedDraft($id:ID!){ShippingOrder(id:$id){id label status update_stock orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{id:String(state.bl.id)});
  if(draft){
   if(String(draft.id)!==String(state.bl.id)||draft.status!=='unpublished'||typeof draft.update_stock!=='boolean'
   ||draft.orders?.paginatorInfo?.hasMorePages!==false||draft.orders?.data?.length!==1||String(draft.orders.data[0].id)!==String(bc.id))throw Error('Brouillon BL : identité ou rattachement non confirmé');
   bl=draft;
  }
 }
 if(state.bl?.id&&!bl)throw Error(state.bl.status==='unpublished'?'Brouillon BL introuvable dans Erplain : reprendre depuis le BC après rapprochement':'BL introuvable dans Erplain : rapprochement nécessaire');
 if(state.bl?.id&&String(bl?.id)!==String(state.bl.id))throw Error('BL différent : contrôle nécessaire');
 return bl;
}
