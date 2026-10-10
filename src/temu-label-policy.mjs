export const temuLabelPolicyMessage="TEMU · Étiquettes TEMU obligatoires : création directe GLS/GOFO interdite";
export function assertDirectCarrierAllowed(order){if(order?.channel==='temu')throw Error(temuLabelPolicyMessage);}
