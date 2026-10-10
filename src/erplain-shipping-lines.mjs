// Erplain's explicit shipping-cost rows belong to the commercial document,
// not to physical quantities. Never infer this from a label or a missing SKU.
export const shippingProductLines=lines=>(lines||[]).filter(line=>!(line.type==='shipping_cost'&&!line.variant));
