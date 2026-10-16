// Called only after a complete, unambiguous read of the active BC and its BL.
// The normal worker retains all stock checks and the stock creation claim.
export function reconcilePublicationState(state,bc){
 if(state.phase!=='publishing_bl')return state;
 const bl=state.bl;
 if(!bl?.id||typeof bc.update_stock!=='boolean'||typeof bl.update_stock!=='boolean')throw Error('Publication BL : politique de stock non confirmée');
 if(!['unpublished','pending','in_preparation','make_the_shipment','ready_to_ship'].includes(bl.status))throw Error('Publication BL : statut incompatible avec une reprise automatique');
 if(bl.update_stock&&!bc.update_stock)throw Error('Publication BL : politique de stock incompatible');
 return {...state,bc:{...state.bc,update_stock:bc.update_stock},phase:bl.status==='unpublished'||bc.update_stock?'bl_created':'creating_stock',publicationReconciledAt:new Date().toISOString()};
}
