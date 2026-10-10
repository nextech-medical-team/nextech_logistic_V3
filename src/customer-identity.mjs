export function erplainCustomerLabel(order){
 const client=order.source_payload?.client;
 return (typeof client==='string'&&client.trim()) || order.recipient || order.address?.name || order.reference;
}
