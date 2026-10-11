export const temuLabelPolicyMessage="TEMU · Choisir explicitement GLS ou GOFO avant une création directe";
// A stored choice is required by workers; only the manual request may validate a new choice.
export function assertDirectCarrierAllowed(order,carrier,{manualChoice=false}={}){
 if(order?.channel!=='temu')return;
 if(order.source_payload?.externalLabel?.active)throw Error('Étiquette externe enregistrée : aucun nouvel achat automatique');
 const selected=manualChoice?carrier:order.transport_choice;
 if(!['gls','gofo'].includes(selected)||(carrier&&carrier!==selected))throw Error(temuLabelPolicyMessage);
 if(selected==='gofo'&&String(order.address?.country).trim().toUpperCase()!=='FR')throw Error('GOFO : livraison en France uniquement ; choisir GLS');
}
