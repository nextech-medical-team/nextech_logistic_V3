export function checkedResumeBc(result,recorded){
 const name=recorded.label||recorded.id;
 if(result?.Order===null)throw Error('BC Erplain '+name+' introuvable lors de la relecture : vérifier le document existant avant reprise, aucune nouvelle création automatique');
 const bc=result?.Order;
 if(!bc||String(bc.id)!==String(recorded.id))throw Error('API Erplain · Identité du BC non confirmée : aucune reprise');
 if(!Array.isArray(bc.line_items))throw Error('API Erplain · Lignes BC non reçues');
 if(!bc.line_items.length)throw Error('BC Erplain '+name+' sans lignes : vérifier le contenu du document avant reprise');
 return bc;
}
