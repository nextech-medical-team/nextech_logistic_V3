// Only the channel declaration is returned. It cannot supply physical tracking.
export function platformIndicativeView(order){
 const s=order.source_payload||{},ob=s.platformStatusObservation;
 const p=ob?.payload?.detail?{temuOrderDetail:ob.payload.detail}:ob?.payload||s.marketplacePendingCorrection||s;
 const candidate=s.shopifyCancellationSync?.proof;
 // Keep fields from one observation; an older cancellation poll must not
 // overwrite a more recent marketplace receipt in the indicative column.
 const candidateAt=Date.parse(candidate?.observedAt),receiptAt=Date.parse(ob?.observedAt);
 const proof=candidate&&(!Number.isFinite(receiptAt)||Number.isFinite(candidateAt)&&candidateAt>=receiptAt)?candidate:null;
 const raw=order.channel==='shopify'?(proof?.fulfillment_status??p.fulfillment_status):order.channel==='temu'?(s.temuDirect?.status??p.temuOrderDetail?.parentOrderMap?.parentOrderStatus):order.channel==='amazon'?(p.OrderStatus??p.orderStatus??p.order_status??p['order-status']):null;
 const observedAt=order.channel==='shopify'?(proof?.observedAt??ob?.observedAt??s.shopifyCancellationObservedAt):order.channel==='temu'?(s.temuDirect?.verifiedAt??ob?.observedAt):ob?.observedAt;
 return {channel:order.channel,status:typeof raw==='number'||typeof raw==='string'?String(raw):null,observedAt:observedAt||null,indicative:true,cancelled:order.channel==='shopify'?!!(proof?.cancelled_at||p.cancelled_at):order.channel==='temu'?Number(raw)===3:false,financialStatus:order.channel==='shopify'?(proof?.financial_status??p.financial_status??null):null,error:order.channel==='shopify'?s.shopifyCancellationSync?.error||null:null};
}
