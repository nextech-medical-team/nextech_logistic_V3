// A published BL supplies the shipment contents, independently of obsolete V3
// mapping/quantity diagnostics. This derives data; it never adds a stock gate.
export async function tenderBlLabelPayload(db,o){
 if(o.channel!=='tender'||o.label_override||!o.erp_live?.bl?.id)return null;
 const bls=new Map();bls.set(String(o.erp_live.bl.id),o.erp_live.bl);
 const shippingOrders=o.erp_live.documentSource?.shippingOrders;
 for(const bl of Array.isArray(shippingOrders)?shippingOrders:[])if(bl?.id&&bl.status!=='cancelled')bls.set(String(bl.id),{...(bls.get(String(bl.id))||{}),...bl});
 // Several BLs may belong to one shipment. Preserve its established payload;
 // do not silently choose one delivery or discard its complements.
 if(bls.size!==1)return null;
 const bl=bls.get(String(o.erp_live.bl.id)),items=(Array.isArray(bl.line_items)?bl.line_items:[]).filter(l=>l.type==='normal');
 if(!items.length||items.some(l=>!l.variant?.sku||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))return null;
 const skus=[...new Set(items.map(l=>l.variant.sku))],weights=new Map((await db.query('SELECT sku,weight_kg FROM products WHERE sku=ANY($1::text[])',[skus])).rows.map(p=>[p.sku,Number(p.weight_kg)]));
 if(skus.some(sku=>!Number.isFinite(weights.get(sku))||weights.get(sku)<=0))return null;
 const weight=items.reduce((sum,l)=>sum+Number(l.quantity)*weights.get(l.variant.sku),0);
 if(!Number.isFinite(weight)||weight<=0)return null;
 const weightKg=Math.ceil((weight-1e-9)*1000)/1000;
 return {blId:String(bl.id),weightKg,parcels:o.carrier?.startsWith('gls')?Math.ceil(weightKg/30):1,lines:items.map(l=>({source_sku:l.variant.sku,target_sku:l.variant.sku,quantity:Number(l.quantity),target_quantity:Number(l.quantity)}))};
}
export function applyTenderBlLabelPayload(o,request){
 const p=request?.blPayload;if(!p)return o;
 if(p.blId!==request.blId)throw Error('Payload d’étiquette lié à un autre BL');
 return {...o,weight_kg:p.weightKg,parcel_count:p.parcels,lines:p.lines};
}
