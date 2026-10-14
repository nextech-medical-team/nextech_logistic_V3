// After a BC exists, shipping amounts and taxes are observations only.
// Preserve document-line identities and quantities to avoid changing shipments.
export function verifySubstitutionShipping(before,after){
 const rows=bc=>{
  if(!Array.isArray(bc?.line_items))throw Error('Lignes de livraison non reçues');
  return bc.line_items.filter(l=>l.type==='shipping_cost').map(l=>{
   if(!l.id||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0)throw Error('Identité ou quantité de livraison non confirmée');
   return [String(l.id),Number(l.quantity)];
  }).sort((a,b)=>a[0].localeCompare(b[0]));
 };
 const a=rows(before),b=rows(after);
 if(new Set(a.map(l=>l[0])).size!==a.length||new Set(b.map(l=>l[0])).size!==b.length||JSON.stringify(a)!==JSON.stringify(b))throw Error('Lignes de livraison modifiées : rapprochement requis');
 return {commercialComparisonPerformed:false};
}
