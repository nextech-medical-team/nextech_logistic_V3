const scope=new Map(); // Périmètre métier privé exclu du dépôt public.
export function authorizedFreshTemu(r,options={}){
 if(options.batch!=="fresh-temu-34-20261008")return false;
 const ref=r.payload?.detail?.parentOrderMap?.parentOrderSn;
 if(r.channel!=="temu"||!scope.has(ref)||String(r.shop)!==scope.get(ref))throw Error("Reprise hors des 34 commandes autorisées");
 if(Number(r.payload.detail.parentOrderMap.parentOrderStatus)===3)throw Error("Commande TEMU annulée : reprise interdite");
 return true;
}
