const referencePattern=/^(?:\d{3}-\d{7}-\d{7}|#?\d+|PO-[\w-]+|SHO(?:-V3-|-)?[\w-]+|V3P-[\w-]+|[CO]\d+|BC-[\w-]+|BDC-[\w-]+)$/i;
function cleanReference(value){return value.replace(/^(\d{3}-\d{7}-\d{7})\/+$/, '$1');}
export function searchTerms(value){
 const text=String(value||'').trim();
 if(text.length>20000)throw Error('Recherche trop longue : maximum 20 000 caractères');
 const groups=text.split(/[,;\r\n\t]+/).map(v=>v.trim()).filter(Boolean);
 const terms=[...new Set(groups.flatMap(group=>{
  const tokens=group.split(/\s+/).filter(Boolean).map(cleanReference);
  return tokens.length>1&&tokens.every(v=>referencePattern.test(v))?tokens:[cleanReference(group)];
 }))];
 if(terms.length>200)throw Error('Maximum 200 références par recherche');
 return terms;
}
