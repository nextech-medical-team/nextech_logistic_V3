// Round a sum up to whole grams without promoting floating point noise to 1 g.
// Positive sub-gram values still produce a positive parcel weight.
export function parcelWeightKg(kg){
 if(!Number.isFinite(kg)||kg<=0)throw Error('Poids du colis invalide');
 const grams=kg*1000,nearest=Math.round(grams);
 const tolerance=Number.EPSILON*Math.max(1,Math.abs(grams))*16;
 return Math.max(1,Math.ceil(Math.abs(grams-nearest)<=tolerance?nearest:grams))/1000;
}
