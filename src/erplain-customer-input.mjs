import {erplainCustomerLabel} from './customer-identity.mjs';
import {invoiceCustomerType} from './invoice-customer-policy.mjs';

// Restore the October 13 creation payload. A number already persisted by the
// newer flow remains authoritative so interruption recovery keeps the same key.
export function erplainCustomerInput(o){
 return {label:erplainCustomerLabel(o),
  customer_number:o.channel==='temu'&&o.erp_live?.customerNumber||'V3:'+o.id,
  customer_type:invoiceCustomerType({orderId:o.id,channel:o.channel,sourcePayload:o.source_payload}),
  notes:'Compte V3. Aucun email envoyé.'};
}
