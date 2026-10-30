// Numeric imports can drop the leading zero of a five-digit Spanish postcode.
// Format only the carrier payload; source orders and ERP documents are untouched.
export function carrierPostal(country,postal){
 const value=String(postal??'').replace(/\s+/g,'').toUpperCase();
 if(String(country??'').trim().toUpperCase()==='LV'&&/^LV-?\d{4}$/.test(value))return value.replace(/^LV-?/,'');
 return String(country??'').trim().toUpperCase()==='ES'&&/^\d{4}$/.test(value)?'0'+value:value;
}
