export async function ensureConsumerCustomer(api,invoice,{orderId}={}){
 const customerId=String(invoice.customer?.id||'');
 if(!/^\d+$/.test(customerId))throw Error('Erplain · Client de la facture non confirmé');
 const read=await api.request('query B2CCustomer($id:ID!){Customer(id:$id){id customer_number customer_type tax_number company_registration_number siret}}',{id:customerId});
 const c=read.Customer;
 if(String(c?.id)!==customerId)throw Error('Erplain · Client de la facture non confirmé');
 if(c.customer_type==='individual')return;
 if(c.customer_type!=='company'||!orderId||c.customer_number!=='V3:'+orderId||c.tax_number||c.company_registration_number||c.siret)throw Error('Erplain · Type du client particulier à rapprocher : fiche partagée ou identifiants professionnels');
 // Only correct a customer owned by this V3 order. An ambiguous response is
 // never replayed here; a later run first reads the current customer again.
 const r=await api.request('mutation B2CCustomerType($id:ID!,$input:CustomerInput!){UpdateCustomer(id:$id,input:$input){id customer_type}}',{id:customerId,input:{customer_type:'individual'}});
 if(String(r.UpdateCustomer?.id)!==customerId||r.UpdateCustomer?.customer_type!=='individual')throw Error('Erplain · Type particulier non confirmé : relire la fiche avant reprise');
}
