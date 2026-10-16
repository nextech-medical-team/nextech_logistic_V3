// Routing reads the products of the recorded BC, without repairing business
// lines or comparing the document with a later marketplace mapping.
export async function recordedBcRoutingLines(db,order,localLines){
 const bc=order.erp_live?.bc;
 if(order.channel==='tender'||order.partial_mode||!bc?.id||!Array.isArray(bc.line_items))return localLines;
 const products=bc.line_items.filter(l=>l.type==='normal');
 if(!products.length||products.some(l=>!l.variant?.sku||l.quantity==null||typeof l.quantity==='boolean'||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0))return localLines;
 const skus=[...new Set(products.map(l=>l.variant.sku))];
 const weights=(await db.query('SELECT p.sku,p.weight_kg,p.origin,c.message FROM products p LEFT JOIN catalog_results c ON c.sku=p.sku WHERE p.sku=ANY($1::text[])',[skus])).rows;
 return products.map(product=>{
  const sku=product.variant.sku,weight=weights.find(w=>w.sku===sku);
  const cached=localLines.filter(l=>l.target_sku===sku&&String(l.source_payload?.erplainSourceVariantId)===String(product.variant.id)&&product.variant.id!=null);
  const verified=cached.length===1?cached[0].source_payload?.erplainCorrectedWeightKg:null;
  const hasVerified=verified!=null&&Number.isFinite(Number(verified))&&Number(verified)>0;
  return {id:'BC:'+product.id,source_sku:sku,target_sku:sku,quantity:Number(product.quantity),target_quantity:Number(product.quantity),source_payload:{},weight_kg:hasVerified?Number(verified):weight?.weight_kg,message:hasVerified?null:weight?.message,origin:weight?.origin};
 });
}
