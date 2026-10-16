// A city correction must never replace the Amazon import's postal code.
// Validate before any ERP write; do not alter the import or existing labels.
export function assertImportedPostalAddress(order,address){
 if(order?.channel!=='amazon')return;
 const source=String(order.source_payload?.shippostalcode??'').trim();
 if(!source)return;
 const normalize=value=>String(value??'').trim().toUpperCase().replace(/\s+/g,'');
 if(normalize(address?.postal)!==normalize(source))throw Error('Adresse Amazon : conserver le code postal de l’import ('+source+'). Corriger la ville ne modifie pas le code postal.');
}
