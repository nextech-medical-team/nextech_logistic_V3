export function erplainWeightInput(weightKg){
 const kg=Number(weightKg);if(!Number.isFinite(kg)||kg<=0||kg>3000)throw Error('Poids unitaire invalide');
 // Erplain rounds weight_amount to two decimals: use grams when kg would lose precision.
 const roundedKg=Math.round(kg*100)/100;
 return Math.abs(roundedKg-kg)>1e-9?{weight_amount:Number((kg*1000).toFixed(6)),weight_unit:'g'}:{weight_amount:kg,weight_unit:'kg'};
}
