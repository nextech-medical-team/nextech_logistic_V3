import {consumerInvoice} from './invoice-customer-policy.mjs';
const id=value=>{if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<=0)throw Error('Identifiant Erplain invalide');return String(value);};
const lines='line_items{quantity variant{id} location{id}}';
export function erplainLifecycleGateway(api){
 const readInvoice=async invoiceId=>{
  const r=await api.request(`query LifecycleInvoice($id:ID!){Invoice(id:$id){id status dated_at due_at total paid_amount remaining_balance customer{id} ${lines} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}}}`,{id:id(invoiceId)});
  if(!r.Invoice)throw Error('Erplain Â· Facture introuvable');return r.Invoice;
 };
 return {
  async verifyLive(){const company=await api.verify();if(Number(company?.id)!==100174)throw Error('Ã‰criture interdite hors Erplain LIVE');},
  async readBL(blId){const r=await api.request(`query LifecycleBL($id:ID!){ShippingOrder(id:$id){id status dated_at invoices_count ${lines} orders(first:100){data{id status} paginatorInfo{hasMorePages}} invoices(first:100){data{id status} paginatorInfo{hasMorePages}}}}`,{id:id(blId)});const b=r.ShippingOrder;if(!b||b.invoices?.paginatorInfo?.hasMorePages||b.orders?.paginatorInfo?.hasMorePages)throw Error('Erplain Â· BL ou documents liÃ©s incomplets');return {...b,invoicesCount:Number(b.invoices_count),invoices:b.invoices?.data};},
  async cancelOrder(orderId){const r=await api.request('mutation LifecycleCancelOrder($id:ID!,$input:OrderInput!){UpdateOrder(id:$id,input:$input){id status}}',{id:id(orderId),input:{status:'cancelled'}});if(r.UpdateOrder?.status!=='cancelled')throw Error('Erplain Â· Annulation BC non confirmÃ©e');},
  async setBLStatus(blId,status){if(!['ready_to_ship','shipped','delivered','cancelled'].includes(status))throw Error('Statut intermÃ©diaire interdit');const r=await api.request('mutation LifecycleBLStatus($ids:[ID!]!,$status:ShippingOrderStatus!){UpdateShippingOrdersStatus(ids:$ids,status:$status)}',{ids:[id(blId)],status});if(!r.UpdateShippingOrdersStatus)throw Error('Erplain Â· Mise Ã  jour BL non confirmÃ©e');},
  async validateBillingSource(blId){
   const source=await api.request('query LifecycleBillingSource($id:ID!){ShippingOrder(id:$id){orders(first:100){data{id total} paginatorInfo{hasMorePages}}}}',{id:id(blId)});
   const orders=source.ShippingOrder?.orders;
   if(orders?.paginatorInfo?.hasMorePages||!orders?.data?.length)throw Error('Facturation · BC source non vérifiable');
   if(orders.data.some(o=>o.total==null||!Number.isFinite(Number(o.total))||Number(o.total)<=0))throw Error('Facturation · Montant du BC absent ou nul : renseigner les prix de vente avant de facturer');
  },
  async createInvoiceFromBL(blId){const r=await api.request('mutation LifecycleCreateInvoice($input:InvoiceFromInput!){CreateInvoiceFrom(input:$input){id status}}',{input:{ShippingOrder:[id(blId)]}});return r.CreateInvoiceFrom;},
  readInvoice,
  async validateInvoiceForBL(invoice,bl){
   const sources=invoice.shipping_orders;
   if(sources?.paginatorInfo?.hasMorePages||sources?.data?.length!==1||String(sources.data[0].id)!==String(bl.id))throw Error('Erplain Â· Facture non dÃ©diÃ©e Ã  ce BL');
   const total=xs=>{if(!Array.isArray(xs)||!xs.length)throw Error('Erplain Â· Lignes absentes');const m=new Map();for(const x of xs){if(!x.variant)continue;const q=Number(x.quantity);if(!Number.isFinite(q)||q<0)throw Error('Erplain Â· QuantitÃ© invalide');const k=String(x.variant.id)+':'+String(x.location?.id||'');m.set(k,(m.get(k)||0)+q);}if(!m.size)throw Error('Erplain Â· Produits absents');return JSON.stringify([...m].sort());};
   if(total(invoice.line_items)!==total(bl.line_items))throw Error('Erplain Â· QuantitÃ©s facture diffÃ©rentes du BL');
   if(invoice.total==null||!Number.isFinite(Number(invoice.total))||Number(invoice.total)<=0)throw Error('Erplain Â· Montant facture absent ou nul');
  },
  async publishInvoiceDraft(invoice){const r=await api.request('mutation LifecyclePublishInvoice($id:ID!,$input:InvoiceInput!){UpdateInvoice(id:$id,input:$input){id status}}',{id:id(invoice.id),input:{status:'draft',due_at:String(invoice.due_at||invoice.dated_at||'').slice(0,10)}});if(!r.UpdateInvoice?.id)throw Error('Erplain Â· Publication facture non confirmÃ©e');},
  async finalizeInvoice(invoice,context={}){
   // E-invoice validation requires business identifiers. Consumer invoices use
   // Erplain's ordinary finalization; all BL/amount/quantity checks still apply.
   if(!consumerInvoice(context)){
    const validation=await api.request('mutation LifecycleValidateInvoice($id:ID!){ValidateEInvoice(id:$id){valid message errors}}',{id:id(invoice.id)});
    if(validation.ValidateEInvoice?.valid!==true)throw Error('Erplain · Facture non validée : '+(validation.ValidateEInvoice?.errors?.join(' ; ')||validation.ValidateEInvoice?.message||'informations à compléter'));
   }
   const r=await api.request('mutation LifecycleFinalizeInvoice($id:ID!,$input:InvoiceInput!){UpdateInvoice(id:$id,input:$input){id status}}',{id:id(invoice.id),input:{status:'unpaid'}});
   if(String(r.UpdateInvoice?.id)!==String(invoice.id)||r.UpdateInvoice?.status!=='unpaid')throw Error('Erplain · Finalisation facture non confirmée');
  },
  async existingPaymentMethod(invoice){
   const r=await api.request('query LifecyclePaymentMethod($id:ID!){Invoice(id:$id){invoice_payments(first:100){data{invoice_payable{... on Payment{payment_method{id}}}} paginatorInfo{hasMorePages}}}}',{id:id(invoice.id)});
   if(r.Invoice?.invoice_payments?.paginatorInfo?.hasMorePages)throw Error('Erplain Â· Historique des rÃ¨glements incomplet');
   const methods=[...new Set((r.Invoice?.invoice_payments?.data||[]).map(p=>p.invoice_payable?.payment_method?.id).filter(Boolean).map(String))];
   // For a first payment leave the method to Erplain; never replace its configuration.
   return methods.length===1?{id:methods[0]}:undefined;
  },
  async createPayment(invoice,{amount,method,date}){const input={customer:{id:id(invoice.customer?.id)},paid_at:date,amount,invoice_payments:[{id:id(invoice.id),amount}],notes:'NEXTECH V3 LIVE â€” solde du BL livrÃ©'};if(method)input.payment_method={id:id(method.id)};const r=await api.request('mutation LifecyclePayment($input:PaymentInput!){CreatePayment(input:$input){id}}',{input});if(!r.CreatePayment?.id)throw Error('Erplain Â· Paiement non confirmÃ©');}
 };
}
