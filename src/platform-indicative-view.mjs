// Only the channel declaration is returned. It cannot supply physical tracking.
export function platformIndicativeView(order){
 const s=order.source_payload||{},ob=s.platformStatusObservation;
 const p=ob?.payload?.detail?{temuOrderDetail:ob.payload.detail}:ob?.payload||s.marketplacePendingCorrection||s;
 const candidate=s.shopifyCancellationSync?.proof;
 // Keep fields from one observation; an older cancellation poll must not
 // overwrite a more recent marketplace receipt in the indicative column.
 const candidateAt=Date.parse(candidate?.observedAt),receiptAt=Date.parse(ob?.observedAt);
 const proof=candidate&&(!Number.isFinite(receiptAt)||Number.isFinite(candidateAt)&&candidateAt>=receiptAt)?candidate:null;
 let raw=order.channel==='shopify'?(proof?.fulfillment_status??p.fulfillment_status):order.channel==='temu'?(s.temuDirect?.status??p.temuOrderDetail?.parentOrderMap?.parentOrderStatus):order.channel==='amazon'?(p.OrderStatus??p.orderStatus??p.order_status??p['order-status']):null;
 let observedAt=order.channel==='shopify'?(proof?.observedAt??ob?.observedAt??s.shopifyCancellationObservedAt):order.channel==='temu'?(s.temuDirect?.verifiedAt??ob?.observedAt):ob?.observedAt;
 if(order.channel==='temu'){
  const cancellation=s.platformCancellationObservation;
  const observations=[
   {status:s.temuDirect?.status,at:s.temuDirect?.verifiedAt},
   {status:p.temuOrderDetail?.parentOrderMap?.parentOrderStatus,at:ob?.observedAt},
   ...(cancellation?.source==='temu_direct'&&cancellation.reference===order.reference&&Number(cancellation.status)===3&&Number.isFinite(Date.parse(cancellation.observedAt))?[{status:3,at:cancellation.observedAt}]:[])
  ].filter(x=>(typeof x.status==='number'||typeof x.status==='string')&&String(x.status).trim());
  observations.sort((a,b)=>(Number.isFinite(Date.parse(b.at))?Date.parse(b.at):-Infinity)-(Number.isFinite(Date.parse(a.at))?Date.parse(a.at):-Infinity));
  if(observations.length){raw=observations[0].status;observedAt=observations[0].at;}
 }
 const result={channel:order.channel,status:typeof raw==='number'||typeof raw==='string'?String(raw):null,observedAt:observedAt||null,indicative:true,cancelled:order.channel==='shopify'?!!(proof?.cancelled_at||p.cancelled_at):order.channel==='temu'?Number(raw)===3:false,financialStatus:order.channel==='shopify'?(proof?.financial_status??p.financial_status??null):null,error:order.channel==='shopify'?s.shopifyCancellationSync?.error||null:null};
 if(order.channel==='temu'&&result.cancelled){
  const bc=order.erp_live?.bc;
  result.cancellationNotice={title:'Annulation TEMU confirmée',message:bc?.id
   ?'BC '+(bc.label||bc.id)+(bc.status==='cancelled'?' annulé dans Erplain.':' : annulation Erplain à vérifier.')+' Vérifier aussi les BL, les stocks et les factures avant toute action.'
   :'Aucun BC Erplain enregistré dans V3. Vérifier la préparation de cette commande.'};
 }
 return result;
}
