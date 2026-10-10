export const postalHeaders=new Set(['shippostalcode','adressedelivraisoncodepostal']);
export function postalCellValue(cell){
 const v=cell.value;
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&/^0{2,12}$/.test(cell.numFmt||''))return String(v).padStart(cell.numFmt.length,'0');
 return v;
}
export function importPostalCode(value,country){
 const text=String(value??'').trim();
 // Codes français à cinq chiffres : récupérer le zéro perdu par une conversion numérique.
 return String(country||'').trim().toUpperCase()==='FR'&&/^\d{4}$/.test(text)?text.padStart(5,'0'):text;
}
