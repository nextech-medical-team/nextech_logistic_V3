// A successful TEMU decrypt response may still contain privacy placeholders.
// Do not turn those placeholders into customer records or shipping documents.
export function temuMaskedCustomerIssue(order){
  if(order.channel!=='temu')return null;
  const address=order.address||{};
  const fields=[['destinataire',order.recipient],['destinataire',address.name],['rue',address.street],['code postal',address.postal],['ville',address.city],['pays',address.country]];
  const masked=[...new Set(fields.filter(([,value])=>/[*＊•●]{2,}/u.test(String(value||''))).map(([label])=>label))];
  return masked.length?'TEMU · Adresse masquée : '+masked.join(', '):null;
}
