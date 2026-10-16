// Cost the recorded preparation rather than rejecting a later global mapping.
// No guessed purchase price: the exact prepared SKU must have a usable profile.
export function preparedTemuMarginCost({profiles,line,orderLine,adapter}){
 const target=String(line?.target_sku||'');
 const mapping=Number(line?.target_quantity)/Number(line?.quantity);
 if(!target||!Number.isFinite(mapping)||mapping<=0)return {error:'Coût des unités préparées indisponible'};
 const same=profiles.filter(r=>String(r.sku_erplain||r.sku_temu)===target);
 const original=same.filter(r=>(orderLine.skuId&&String(r.sku_id||'')===String(orderLine.skuId))||String(r.sku_temu)===String(orderLine.sku));
 const matches=original.length===1?original:same;
 if(matches.length!==1)return {error:'Coût du SKU préparé absent ou ambigu dans le référentiel'};
 const profile=matches[0],found=adapter.find({...orderLine,sku:String(profile.sku_temu),skuId:String(profile.sku_id||'')});
 if(!found.cost)return found;
 const cost=found.cost,base=Number(cost.mapping);
 if(!(base>0)||!Number.isFinite(base))return {error:'Coût unitaire du SKU préparé non vérifiable'};
 return {cost:{...cost,mapping,supplierTransport:cost.supplierTransport===null?null:cost.supplierTransport*mapping/base,weight:cost.weight===null?null:cost.weight*mapping/base,warning:'Coûts du SKU préparé et quantités préparées ; mapping global non bloquant après BL'}};
}
