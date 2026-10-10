export function stockTransferPlan(source,target,mapping){
 if(mapping.sourceCompany!==100174||mapping.targetCompany!==100174)throw new Error('Sociétés interdites');
 const bySource=new Map(source.map(v=>[v.id,v])),byTarget=new Map(target.map(v=>[v.id,v]));
 const links=Object.values(mapping.products).flatMap(p=>p.variants);
 if(new Set(links.map(v=>v.targetVariantId)).size!==links.length)throw new Error('Cibles dupliquées');
 return links.map(v=>{const s=bySource.get(v.sourceVariantId),t=byTarget.get(v.targetVariantId);if(!s||!t||s.sku!==v.sku||t.sku!==v.sku)throw new Error('Correspondance invalide : '+v.sku);
 if(!s.track_inventory)return {...v,excluded:'Produit sans gestion de stock'};
 if(s.has_serial_numbers||t.has_serial_numbers)throw new Error('Numéros de série à traiter : '+v.sku);
 if(s.on_hand==null||t.on_hand==null||!Number.isFinite(Number(s.on_hand))||!Number.isFinite(Number(t.on_hand)))throw new Error('Stock réel indisponible : '+v.sku);
 const desired=Number(s.on_hand),before=Number(t.on_hand),delta=Math.round((desired-before)*1e6)/1e6;
 return {...v,desired,before,delta,sourceAvailable:s.available,sourceReserved:s.reserved,sourceIncoming:s.incoming};});
}
