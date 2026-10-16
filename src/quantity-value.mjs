// Decimal/scientific spreadsheet values are accepted. JavaScript-only radix
// syntax and ambiguous spacing are not. Rejected rows remain in receptions.
export function positiveImportQuantity(value,{integer=false}={}){
 if(!['string','number'].includes(typeof value))throw Error(integer?'Quantité entière positive requise':'Quantité positive requise');
 const raw=String(value??'').trim(),plain=/^\+?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[+-]?\d+)?$/i;
 const grouped=/^\+?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/;
 if(!plain.test(raw)&&!grouped.test(raw))throw Error(integer?'Quantité entière positive requise':'Quantité positive requise');
 const number=Number(raw.replace(/[ \u00a0\u202f]/g,'').replace(',','.'));
 if(!Number.isFinite(number)||number<=0||integer&&!Number.isSafeInteger(number))throw Error(integer?'Quantité entière positive requise':'Quantité positive requise');
 return number;
}
