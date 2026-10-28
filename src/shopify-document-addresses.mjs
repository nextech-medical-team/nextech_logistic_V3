import {normalizeRelayAddress,readShopifyRelay} from './shopify-relay-source.mjs';

// The operational GLS address remains the original client address. Documents
// use the selected relay destination and the separate Shopify billing address.
export function shopifyDocumentAddresses(order){
 const source=order.source_payload||{},relay=readShopifyRelay(source);
 const shipping=relay?.selectedId?relay.destinationAddress:order.address;
 const billing=source.billing_address?normalizeRelayAddress(source.billing_address):(relay?.clientAddress||order.address);
 return {shipping,billing};
}
