// This diagnostic deliberately has no database, purchase or PDF capability.
// Its caller must supply the API for the order's verified TEMU shop.
export async function readTemuOrderDiagnostic(api,reference,{knownPackages=[]}={}){
 if(typeof reference!=='string'||!/^PO-\d+-\d+$/.test(reference))throw Error('Référence TEMU invalide');
 if(!Array.isArray(knownPackages)||knownPackages.some(p=>typeof p!=='string'||!/^PK-\d+$/.test(p)))throw Error('TEMU · Colis locaux non vérifiables');
 const detail=await api.read('bg.order.detail.v2.get',{parentOrderSn:reference});
 if(detail?.parentOrderMap?.parentOrderSn!==reference||!Array.isArray(detail.orderList)||!detail.orderList.length)throw Error('TEMU · Identité ou articles de commande incohérents');
 const status=Number(detail.parentOrderMap.parentOrderStatus);

 const orderSns=detail.orderList.map(l=>l.orderSn);
 if(orderSns.some(s=>typeof s!=='string'||!s)||new Set(orderSns).size!==orderSns.length)throw Error('TEMU · Références des lignes incomplètes ou dupliquées');
 const flags=[...(detail.parentOrderMap.parentOrderLabel||[]),...detail.orderList.flatMap(l=>l.orderLabel||[])];
 const cancellationRequested=flags.some(f=>f==='pending_buyer_cancellation'||f?.name==='pending_buyer_cancellation'&&[1,'1',true].includes(f.value));
 const result={reference,provider:'TEMU',readOnly:true,checkedAt:new Date().toISOString(),status,cancellationRequested,shipments:[],errors:[]};
 const cancellationMessage=status===3?'TEMU confirme l’annulation de la commande.':cancellationRequested?'TEMU signale une demande d’annulation du client.':null;
 const seen=new Set(),packages=new Set([...knownPackages,...detail.orderList.flatMap(l=>(l.packageSnInfo||[]).map(p=>p.packageSn)).filter(Boolean)]);
 // Cancellation is an observation, not proof that an existing parcel disappeared.
 // An already cancelled order without any known parcel needs no shipment lookup.
 for(const orderSn of orderSns){
  let response;
  try{response=await api.read('bg.logistics.shipment.v2.get',{parentOrderSn:reference,orderSn});}
  catch(e){result.errors.push({orderSn,message:String(e?.message||e).slice(0,450)});continue;}
  if(!Array.isArray(response?.shipmentInfoDTO))throw Error('TEMU · Réponse des expéditions incomplète');
  for(const shipment of response.shipmentInfoDTO){
   for(const parcel of [shipment,...(shipment.subPackageShipmentInfoList||[])]){
    if(parcel.parentOrderSn&&parcel.parentOrderSn!==reference)throw Error('TEMU · Expédition associée à une autre commande');
    if(parcel.orderSn&&!orderSns.includes(parcel.orderSn))throw Error('TEMU · Expédition associée à une autre ligne');
    const key=JSON.stringify(parcel);
    if(parcel.packageSn)packages.add(parcel.packageSn);
    if(!seen.has(key)){seen.add(key);result.shipments.push(parcel);}
   }
  }
 }
 if([...packages].some(p=>!/^PK-\d+$/.test(p)))throw Error('TEMU · Identifiant de colis invalide');
 result.packages=[];
 if(packages.size){
  let response,received=false;try{response=await api.read('bg.logistics.shipment.result.get',{packageSnList:[...packages]});received=true;}catch(e){result.errors.push({message:String(e?.message||e).slice(0,450)});}
  if(received){
   const rows=response?.packageInfoResultList;
   if(!Array.isArray(rows)||rows.length!==packages.size||new Set(rows.map(p=>p.packageSn)).size!==packages.size)throw Error('TEMU · Résultat des colis incomplet');
   for(const p of rows)if(!packages.has(p.packageSn)||!p.orderSendInfoList?.some(l=>l.parentOrderSn===reference))throw Error('TEMU · Identité du colis non vérifiable');
   result.packages=rows;
   for(const p of rows){
    if(Number(p.shippingLabelStatus)===2)result.errors.push({packageSn:p.packageSn,message:'TEMU · Étiquette refusée : '+String(p.failReasonText||'motif non communiqué').slice(0,450)});
    else if(Number(p.shippingLabelStatus)!==1)result.errors.push({packageSn:p.packageSn,message:'TEMU · Étiquette non disponible pour le colis '+p.packageSn+' : préparation à vérifier chez TEMU'});
   }
  }
 }
 result.message=result.errors.length?'Lecture TEMU partielle : certains statuts d’expédition restent indisponibles.':result.shipments.length||result.packages.length?'Informations de commande et d’expédition relues depuis TEMU.':'Commande relue depuis TEMU ; aucune expédition renvoyée. Cela ne prouve pas qu’une nouvelle étiquette doit être achetée.';
 if(result.packages.length&&!result.errors.length)result.message='TEMU confirme '+result.packages.length+' étiquette(s) disponible(s). '+result.packages.map(p=>[p.packageSn,p.shippingCompanyName,p.trackingNumber].filter(Boolean).join(' · ')).join(' ; ')+'. Les PDF et numéros de suivi existants sont conservés.';
 if(cancellationMessage)result.message=cancellationMessage+' '+result.message;
 result.message='État source TEMU : '+status+'. '+result.message;
 return result;
}
