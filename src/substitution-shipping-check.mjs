// Erplain can allocate a rounding cent to another line after replacing a product.
// Shipping net price, identity, quantity and tax codes must still remain unchanged.
export function verifySubstitutionShipping(before,after){
 const fail=()=>{throw Error('Frais de livraison modifiés : rapprochement requis');};
 const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):NaN;
 const cents=v=>Math.round((v+Number.EPSILON)*100);
 const rows=bc=>{
  if(!Array.isArray(bc?.line_items)||!['inclusive','exclusive'].includes(bc.tax_type))return fail();
  return bc.line_items.filter(l=>l.type==='shipping_cost').map(l=>{
   const quantity=number(l.quantity),price=number(l.price),tax=number(l.tax_amount);
   if(!l.id||quantity<=0||!Number.isFinite(quantity)||price<0||!Number.isFinite(price)||tax<0||!Number.isFinite(tax)||!Array.isArray(l.tax_codes)||l.tax_codes.some(t=>!t.id))return fail();
   const net=price*quantity-(bc.tax_type==='inclusive'?tax:0);
   return {id:String(l.id),quantity,net,tax:cents(tax),gross:cents(net+tax),codes:JSON.stringify(l.tax_codes.map(t=>String(t.id)).sort())};
  }).sort((a,b)=>a.id.localeCompare(b.id));
 };
 const a=rows(before),b=rows(after);
 if(a.length!==b.length||new Set(a.map(x=>x.id)).size!==a.length||new Set(b.map(x=>x.id)).size!==b.length)return fail();
 // The residual from rounding every line can be assigned to the final line.
 const taxableCount=bc=>bc.line_items.filter(l=>number(l.tax_amount)>0||l.tax_codes?.some(t=>t.tax_rates?.some(r=>number(r.rate)>0))).length;
 const roundingLimit=Math.max(1,Math.ceil(Math.max(taxableCount(before),taxableCount(after))/2));
 let rounding=false;
 for(let i=0;i<a.length;i++){
  const x=a[i],y=b[i];
  if(x.id!==y.id||x.quantity!==y.quantity||x.codes!==y.codes||Math.abs(x.net-y.net)>1e-7)return fail();
  if(x.tax!==y.tax||x.gross!==y.gross){
   if(Math.abs(x.tax-y.tax)>roundingLimit||Math.abs(x.gross-y.gross)>roundingLimit)return fail();
   rounding=true;
  }
 }
 if(rounding){
  const taxTotal=bc=>bc.line_items.reduce((n,l)=>n+number(l.tax_amount),0);
  const bt=number(before.total),at=number(after.total),bv=taxTotal(before),av=taxTotal(after);
  if(![bt,at,bv,av].every(Number.isFinite)||!before.currency?.label||before.currency.label!==after.currency?.label||cents(bt)!==cents(at)||cents(bv)!==cents(av))return fail();
 }
 return {roundingRedistributed:rounding};
}
