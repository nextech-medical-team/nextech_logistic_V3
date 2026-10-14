const fields='id label status update_stock available_for_shipping need_reorder reserved_quantity committed_quantity shipped_quantity total tax_type currency{label} line_items{type quantity reserved_quantity shipped_quantity variant{id sku track_inventory} tax_codes{id} price tax_amount ecotax discount discount_rule_amount}';
const numeric=v=>['number','string'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0;
export function confirmsDocumentReservation(bc){
 const normal=bc.line_items?.filter(l=>l.type==='normal')||[];
 if(bc.status!=='active'||bc.update_stock!==true||bc.available_for_shipping!==true||bc.need_reorder!==false||!normal.length)return false;
 // The ERP document counters include committed stock; a line's reserved_quantity
 // alone can be zero even when the ERP confirms the whole order can ship.
 if(normal.some(l=>l.variant?.track_inventory!==true||!numeric(l.quantity)||Number(l.quantity)<=0))return false;
 if(![bc.reserved_quantity,bc.committed_quantity,bc.shipped_quantity].every(numeric))return false;
 const quantity=normal.reduce((sum,l)=>sum+Number(l.quantity),0);
 return Math.abs(Number(bc.reserved_quantity)+Number(bc.committed_quantity)+Number(bc.shipped_quantity)-quantity)<=1e-6;
}
const reservationError=l=>Error('BC · Quantités réservées non confirmées · SKU '+(l.variant.sku||l.variant.id||'inconnu')+' : commandées '+l.quantity+', réservées '+(l.reserved_quantity??'non reçues')+', expédiées '+(l.shipped_quantity??'non reçues'));
export function assertPublishedBcReservation(bc,stockPolicy){
 if(typeof stockPolicy!=='boolean'||bc?.update_stock!==stockPolicy)throw Error('BC · Politique de stock publiée non confirmée');
 if(!stockPolicy)return; // Existing documents retain their immutable legacy policy.
 if(!Array.isArray(bc.line_items)||!bc.line_items.length)throw Error('BC · Réservations non reçues');
 const inconsistent=[];
 for(const l of bc.line_items){
  if(l.type!=='normal')continue;
  if(typeof l.variant?.track_inventory!=='boolean')throw Error('BC · Suivi du stock produit non vérifié');
  if(!l.variant.track_inventory)continue;
  if(!numeric(l.quantity)||Number(l.quantity)<=0||!numeric(l.shipped_quantity)||Number(l.shipped_quantity)>Number(l.quantity))throw reservationError(l);
  if(!numeric(l.reserved_quantity)||Math.abs(Number(l.reserved_quantity)+Number(l.shipped_quantity)-Number(l.quantity))>1e-6)inconsistent.push(l);
 }
 if(inconsistent.length&&!confirmsDocumentReservation(bc))throw reservationError(inconsistent[0]);
}
export async function nextBcNumber(api,datedAt){
 const {DocumentNumberingContext:c}=await api.request('query V3BcNumber($date:String){DocumentNumberingContext(document_type:"order",dated_at:$date){preview manual_override_allowed_effective}}',{date:datedAt});
 if(!c?.manual_override_allowed_effective||!/^C[0-9]+$/.test(c.preview||''))throw Error('BC · Séquence officielle Erplain non disponible');return c.preview;
}
export async function publishIncrementalBc(api,id,{datedAt,verify,lock,expectedStockPolicy}){return lock(async()=>{
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
 const {Order:confirmed}=await api.request(`query V3BcNumberVerify($id:ID!){Order(id:$id){${fields}}}`,{id:String(id)});
 if(String(confirmed?.id)!==String(id)||confirmed?.status!=='active'||confirmed.label!==label)throw Error('BC · Numéro publié non confirmé');verify(confirmed);assertPublishedBcReservation(confirmed,bc.update_stock);return confirmed;
 }throw Error('BC · Numérotation occupée : reprise nécessaire');
 });}
