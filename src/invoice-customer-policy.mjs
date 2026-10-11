// User policy: TEMU, Shopify and Amazon buyers are consumers by default.
// Explicit business evidence takes precedence; unknown channels keep validation.
export function consumerInvoice({channel,sourcePayload={}}={}){
 if(!['temu','shopify','amazon'].includes(channel))return false;
 const p=sourcePayload||{};
 const yes=v=>v===true||String(v).trim().toLowerCase()==='true';
 if([p.isbusinessorder,p.isBusinessOrder,p.is_business_order,p.b2b,p.isB2B].some(yes))return false;
 if(['business','company','professional','b2b'].includes(String(p.customer_type||p.customerType||'').toLowerCase()))return false;
 if(p.company||p.billing_address?.company||p.billingAddress?.company)return false;
 return true;
}
