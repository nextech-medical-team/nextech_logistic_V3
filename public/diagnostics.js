function warningText(value){return String(value||'').replaceAll('Plusieurs produits Erplain actifs portent ce SKU','Plusieurs produits actifs portent ce SKU dans Erplain : sélectionner le produit correct').replaceAll('SKU absent ou inactif dans Erplain','Aucun produit actif trouvé pour ce SKU dans Erplain').replaceAll('Produit introuvable ou inactif dans Erplain','Aucun produit actif trouvé pour ce SKU dans Erplain').replaceAll('Référence Erplain absente ou ambiguë :','La référence Erplain n’a pas été identifiée ; motif détaillé non enregistré :').replaceAll('Poids non renseigné dans Erplain','Poids unitaire manquant dans Erplain');}
function skuLineText(order,line){
 const sku=line.sku||line.mapped_sku||line.source_sku||'SKU source manquant';
 const quantity=['tender','samples'].includes(order.channel)?line.source_quantity??line.quantity:line.quantity??line.source_quantity;
 const replacements=(order.sku_replacements||[]).filter(r=>r.replacementSku===sku&&r.originalSku!==sku);
 if(replacements.length){
  const text=replacements.map(r=>r.originalSku+' ('+r.replaceQuantity+') → '+r.replacementSku+' ('+r.replacementQuantity+')').join(' ; ');
  const replaced=replacements.reduce((sum,r)=>sum+Number(r.replacementQuantity),0);
  return text+(quantity!=null&&Math.abs(Number(quantity)-replaced)>1e-6?' · Total '+sku+' ('+quantity+')':'');
 }
 return sku+(quantity!=null?' ('+quantity+')':' — quantité non enregistrée');
}
function skuColumnLineText(order,line,index,lines){
 const sku=line.sku||line.mapped_sku||line.source_sku;
 if(!(order.sku_replacements||[]).some(r=>r.replacementSku===sku))return skuLineText(order,line);
 const key=l=>l.sku||l.mapped_sku||l.source_sku;
 if(lines.slice(0,index).some(l=>key(l)===sku))return '';
 const quantity=lines.filter(l=>key(l)===sku).reduce((sum,l)=>sum+Number(l.quantity??l.source_quantity),0);
 return skuLineText(order,{...line,quantity,source_quantity:quantity});
}
function orderProblemText(order){const messages=[];for(const line of order.sku_lines||[]){if(!['tender','samples','temu'].includes(order.channel)&&line.mapping_exists===false&&!line.sku)messages.push('Correspondance SKU absente : '+line.source_sku+' → sélectionner le SKU Erplain');if(line.catalog_issue)messages.push((line.sku||line.mapped_sku||line.source_sku)+' : '+line.catalog_issue);}for(const m of [order.carrier_job?.error,order.erp_live_job?.error,order.issue])if(m)messages.push(m);return [...new Set(messages.map(warningText))].join(' ; ')||(!order.label_manual_request_required&&['blocked','waiting_catalog','review','failed'].includes(order.carrier_job?.status||order.label_status)?'Traitement bloqué : aucun motif détaillé enregistré. Consulter le journal de cette commande.':'');}
function transportPendingText(order){if(order.weight_kg)return order.weight_kg+' kg · '+order.parcel_count+' colis';const issue=orderProblemText(order);if(/Correspondance SKU absente/.test(issue))return 'Calcul du poids bloqué par la correspondance SKU manquante';if(/Poids unitaire manquant/.test(issue))return 'Poids unitaire à renseigner dans Erplain';if(/produit.*(introuvable|inactif)|Aucun produit actif|Plusieurs produits actifs/i.test(issue))return 'Calcul du poids bloqué par le produit Erplain';if(/Informations transport manquantes/.test(issue))return 'Adresse à compléter avant préparation';return 'Poids total non calculé';}

function postBlLabelHistoryHtml(order){return '<span class="badge">Nouvelle demande manuelle attendue</span><details class="label-diagnostic-history"><summary>Historique de l’étiquette</summary>'+[...new Set((order.label_diagnostic_history||[]).map(h=>h.reason))].map(reason=>'<div>Ancien refus : '+esc(reason)+'</div>').join('')+'</details>';}
