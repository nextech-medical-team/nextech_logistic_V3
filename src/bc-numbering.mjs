const fields='id label status update_stock total tax_type currency{label} line_items{type quantity reserved_quantity shipped_quantity variant{id sku track_inventory} tax_codes{id} price tax_amount ecotax discount discount_rule_amount}';
const numeric=v=>['number','string'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0;
const lineQuantityError=l=>Error('BC · Quantité de ligne ou quantité expédiée invalide · SKU '+(l.variant.sku||l.variant.id||'inconnu')+' : commandées '+l.quantity+', réservées '+(l.reserved_quantity??'non reçues')+', expédiées '+(l.shipped_quantity??'non reçues'));
// Human decision: reservation counters are observations, never an equality gate.
export function assertPublishedBcReservation(bc,stockPolicy){
 if(typeof stockPolicy!=='boolean'||bc?.update_stock!==stockPolicy)throw Error('BC · Politique de stock publiée non confirmée');
 if(!stockPolicy)return; // Existing documents retain their immutable legacy policy.
 if(!Array.isArray(bc.line_items)||!bc.line_items.length)throw Error('BC · Lignes non reçues');
 for(const l of bc.line_items){
  if(l.type!=='normal')continue;
  if(typeof l.variant?.track_inventory!=='boolean')throw Error('BC · Suivi du stock produit non vérifié');
  if(!l.variant.track_inventory)continue;
  if(!numeric(l.quantity)||Number(l.quantity)<=0||!numeric(l.shipped_quantity)||Number(l.shipped_quantity)>Number(l.quantity))throw lineQuantityError(l);
 }
}
export async function nextBcNumber(api,datedAt){
 const {DocumentNumberingContext:c}=await api.request('query V3BcNumber($date:String){DocumentNumberingContext(document_type:"order",dated_at:$date){preview manual_override_allowed_effective}}',{date:datedAt});
 if(!c?.manual_override_allowed_effective||!/^C[0-9]+$/.test(c.preview||''))throw Error('BC · Séquence officielle Erplain non disponible');return c.preview;
}
export async function publishIncrementalBc(api,id,{datedAt,verify,lock,expectedStockPolicy,preserveInstalled=false}){return lock(async()=>{
 for(let attempt=0;attempt<5;attempt++){
 const {Order:bc}=await api.request(`query V3BcNumberRead($id:ID!){Order(id:$id){${fields}}}`,{id:String(id)});
 if(!bc||String(bc.id)!==String(id))throw Error('BC · Document absent');verify(bc);
 if(typeof expectedStockPolicy==='boolean'&&bc.update_stock!==expectedStockPolicy)throw Error('BC · Politique de réservation différente de la création : rapprochement requis');
 if(bc.status==='active')return bc;
 if(bc.status!=='unpublished')throw Error('BC · Statut modifié : contrôler avant reprise');
 if(typeof bc.update_stock!=='boolean')throw Error('BC · Politique de stock du brouillon non vérifiée');
 const label=await nextBcNumber(api,datedAt);let updated;
 try{({UpdateOrder:updated}=await api.request(`mutation V3PublishPricedBC($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){${fields}}}`,{id:String(id),input:{label,status:'active',update_stock:bc.update_stock}}));}
 catch(e){if(/label.*already in use/i.test(e.message)&&attempt<4)continue;throw e;}
 if(String(updated?.id)!==String(id)||updated.status!=='active'||updated.label!==label)throw Error('BC · Publication ou numéro non confirmé');verify(updated);
 if(!preserveInstalled&&process.env.ERPLAIN_BC_RESPONSE_REUSE!=='0'&&Array.isArray(updated.line_items)&&updated.update_stock===bc.update_stock){assertPublishedBcReservation(updated,bc.update_stock);return updated;}
 const {Order:confirmed}=await api.request(`query V3BcNumberVerify($id:ID!){Order(id:$id){${fields}}}`,{id:String(id)});
 if(String(confirmed?.id)!==String(id)||confirmed?.status!=='active'||confirmed.label!==label)throw Error('BC · Numéro publié non confirmé');verify(confirmed);assertPublishedBcReservation(confirmed,bc.update_stock);return confirmed;
 }throw Error('BC · Numérotation occupée : reprise nécessaire');
 });}
