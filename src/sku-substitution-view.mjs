// Read the successful local transaction journal, never infer a substitution
// from a shared mapping or a preview that has not updated the BC.
export async function attachSkuSubstitutions(db,orders){
 if(!orders.length)return;
 const entries=(await db.query("SELECT detail FROM audit WHERE action='order.product_substituted' AND detail->>'orderId'=ANY($1::text[]) ORDER BY created_at,id",[orders.map(o=>o.id)])).rows;
 const byOrder=new Map();
 for(const {detail:d} of entries){
  if(!d||!d.originalSku||!d.replacementSku||d.originalSku===d.replacementSku||!Number.isFinite(Number(d.replaceQuantity))||Number(d.replaceQuantity)<=0||!Number.isFinite(Number(d.replacementQuantity))||Number(d.replacementQuantity)<=0)continue;
  const list=byOrder.get(d.orderId)||[];
  list.push({originalSku:d.originalSku,replacementSku:d.replacementSku,replaceQuantity:Number(d.replaceQuantity),replacementQuantity:Number(d.replacementQuantity)});byOrder.set(d.orderId,list);
 }
 for(const o of orders)o.sku_replacements=byOrder.get(o.id)||[];
}
