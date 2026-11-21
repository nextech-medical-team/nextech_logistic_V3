const cents = amount => Math.round(amount * 100);

// Allocate the converted gross total in cents, including freight. Send TTC
// prices so Erplain can calculate VAT without rounding the HT price first.
export function convertTemuPricingToEur(source, rate) {
 if (!Number.isFinite(rate) || rate <= 0) throw Error('BC TEMU · Taux de change Erplain invalide');
 const {items, lineAmounts} = source;
 if (!items.length || items.length !== lineAmounts.length || !Number.isFinite(source.total) ||
     lineAmounts.some(line => !Number.isFinite(line.gross) || line.gross < 0 ||
       !Number.isFinite(line.rate) || line.rate < 0 || !Number.isFinite(line.quantity) || line.quantity <= 0)) {
  throw Error('BC TEMU · Montants à convertir incomplets');
 }
 const sourceGross = lineAmounts.reduce((sum, line) => sum + cents(line.gross), 0);
 const total = cents(source.total / rate);
 if (!Number.isSafeInteger(total) || total < 0 || sourceGross !== cents(source.total)) {
  throw Error('BC TEMU · Total des lignes source à rapprocher avant conversion');
 }
 let runningSource = 0;
 let allocated = 0;
 let taxTotal = 0;
 const converted = lineAmounts.map((line, index) => {
  runningSource += cents(line.gross);
  const runningEur = cents(runningSource / (100 * rate));
  const gross = (runningEur - allocated) / 100;
  allocated = runningEur;
  const tax = cents(gross * line.rate / (100 + line.rate));
  taxTotal += tax;
  const price = gross / line.quantity;
  return {item:{...items[index],price},line:{
   type:line.type,variantId:line.variantId,quantity:line.quantity,taxCodes:line.taxCodes,
   unitPrice:price,basis:'gross',gross,tax:tax / 100,rate:line.rate
  }};
 });
 return {
  version:source.version,source:source.source,currency:'EUR',tax_type:'inclusive',
  total:total / 100,sourceLinesTotal:total / 100,tax:taxTotal / 100,
  items:converted.map(entry => entry.item),lineAmounts:converted.map(entry => entry.line),
  taxPolicy:source.taxPolicy,commercialBasis:source.commercialBasis,
  conversion:{currency:source.currency,total:source.total,tax:source.tax,rate}
 };
}

export function assertTemuEurTotal(bc, pricing) {
 if (bc.currency?.label !== 'EUR' || bc.total == null || !Number.isFinite(Number(bc.total)) ||
     cents(Number(bc.total)) !== cents(pricing.total)) {
  throw Error('BC TEMU · Devise ou total en euros différent de la conversion enregistrée');
 }
}
