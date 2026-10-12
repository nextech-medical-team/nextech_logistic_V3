export function orderMarginMapping(found,line){
 if(!found?.cost||line?.source_payload?.mappingScope!=='order')return found;
 const quantity=Number(line.quantity),prepared=Number(line.target_quantity),previous=Number(found.cost.mapping);
 if(!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(prepared)||prepared<=0||!Number.isFinite(previous)||previous<=0)return {error:'Quantité propre à la commande invalide pour la marge'};
 const mapping=prepared/quantity;
 return {...found,cost:{...found.cost,mapping,weight:Number.isFinite(found.cost.weight)?found.cost.weight*mapping/previous:found.cost.weight}};
}
