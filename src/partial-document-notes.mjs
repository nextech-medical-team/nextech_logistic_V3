export function partialDocumentNotes(o){
 if(o.channel==='tender')return String(o.source_payload?.notes??(o.source_payload?.erplainImported?o.erp_live?.bc?.notes:undefined)??'');
 return 'Livraison partielle de '+o.reference;
}
