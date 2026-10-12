// User policy: TEMU, Shopify and Amazon buyers are consumers by default.
// Explicit business evidence takes precedence; unknown channels keep validation.
export function consumerInvoice({channel,sourcePayload={},orderId}={}){
 if(!['temu','shopify','amazon'].includes(channel))return false;
 const p=sourcePayload||{};
 // A human decision applies only to its own Amazon order's business marker.
 const decision=p.invoiceCustomerClassification;
 const confirmedConsumer=channel==='amazon'&&!!orderId&&decision?.orderId===orderId&&decision.authority==='human'&&decision.customerType==='individual'&&Number.isFinite(Date.parse(decision.confirmedAt));
 const yes=v=>v===true||String(v).trim().toLowerCase()==='true';
 if([p.b2b,p.isB2B].some(yes)||!confirmedConsumer&&[p.isbusinessorder,p.isBusinessOrder,p.is_business_order].some(yes))return false;
 if(['business','company','professional','b2b'].includes(String(p.customer_type||p.customerType||'').toLowerCase()))return false;
 if(p.company||p.billing_address?.company||p.billingAddress?.company)return false;
 return true;
}

export function invoiceCustomerType(context){return consumerInvoice(context)?'individual':'company';}
