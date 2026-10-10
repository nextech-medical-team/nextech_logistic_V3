const fields='id label status total tax_type currency{label} line_items{type quantity variant{id} tax_codes{id} price tax_amount ecotax discount discount_rule_amount}';
export async function nextBcNumber(api,datedAt){
 const {DocumentNumberingContext:c}=await api.request('query V3BcNumber($date:String){DocumentNumberingContext(document_type:"order",dated_at:$date){preview manual_override_allowed_effective}}',{date:datedAt});
 if(!c?.manual_override_allowed_effective||!/^C[0-9]+$/.test(c.preview||''))throw Error('BC · Séquence officielle Erplain non disponible');return c.preview;
}
export async function publishIncrementalBc(api,id,{datedAt,verify,lock}){return lock(async()=>{
 for(let attempt=0;attempt<5;attempt++){
 const {Order:bc}=await api.request(`query V3BcNumberRead($id:ID!){Order(id:$id){${fields}}}`,{id:String(id)});
 if(!bc||String(bc.id)!==String(id))throw Error('BC · Document absent');verify(bc);
 if(bc.status==='active')return bc;
 if(bc.status!=='unpublished')throw Error('BC · Statut modifié : contrôler avant reprise');
 const label=await nextBcNumber(api,datedAt);let updated;
 try{({UpdateOrder:updated}=await api.request(`mutation V3PublishPricedBC($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){${fields}}}`,{id:String(id),input:{label,status:'active',update_stock:false}}));}
 catch(e){if(/label.*already in use/i.test(e.message)&&attempt<4)continue;throw e;}
 if(String(updated?.id)!==String(id)||updated.status!=='active'||updated.label!==label)throw Error('BC · Publication ou numéro non confirmé');verify(updated);
 const {Order:confirmed}=await api.request(`query V3BcNumberVerify($id:ID!){Order(id:$id){${fields}}}`,{id:String(id)});
 if(String(confirmed?.id)!==String(id)||confirmed?.status!=='active'||confirmed.label!==label)throw Error('BC · Numéro publié non confirmé');verify(confirmed);return confirmed;
 }throw Error('BC · Numérotation occupée : reprise nécessaire');
 });}
