// One request, one decision: delivery closes every current diagnostic.
// A delivered BL alone is not delivery of a still-open order/remainder.
function isDeliveredOrder(order){
 if(order.tracking_status==='delivered')return true;
 const state=order.erp_live||{},bc=state.bc||{};
 const bls=Array.isArray(state.documentSource?.shippingOrders)?state.documentSource.shippingOrders:bc.shipping_orders?.paginatorInfo?.hasMorePages===false?bc.shipping_orders.data:null;
 if(!Array.isArray(bls))return false;
 const current=bls.filter(b=>b.status!=='cancelled');
 if(!current.length||current.some(b=>!b.id||b.status!=='delivered'))return false;
 const lines=Array.isArray(bc.line_items)?bc.line_items.filter(l=>l.variant):[];
 return lines.length>0&&lines.every(l=>l.quantity!=null&&l.shipped_quantity!=null&&String(l.quantity).trim()!==''&&String(l.shipped_quantity).trim()!==''&&Number.isFinite(Number(l.quantity))&&Number(l.quantity)>=0&&Number.isFinite(Number(l.shipped_quantity))&&Number(l.shipped_quantity)>=Number(l.quantity));
}
function compactProblem(raw,sku='',provider='Erplain') {
 const text=String(raw||'');const explicitSku=text.match(/^(?:Produit équivalent|Produit restant|Produit de remplacement) \[([^\]]+)\] : /)?.[1];if(explicitSku)sku=explicitSku;const code=text.match(/(?:HTTP\s*|\()(\d{3})(?:\)|\b)/i)?.[1];
 const result=(type,label,s=sku)=>({type,label,sku:s,detail:text,provider:apiName});
 const apiName=/GOFO/i.test(text)?'GOFO':/GLS/i.test(text)?'GLS':/TEMU/i.test(text)?'TEMU':/Shopify/i.test(text)?'Shopify':provider;
 if(/Étiquette refusée par TEMU|TEMU.*Étiquette refusée/i.test(text))return result('temu-label-refused','Étiquette refusée par TEMU','');
 if(/^(?:TEMU · )?Quota partagé : lecture différée$/.test(text))return {...result('temu-read-deferred','Lecture TEMU à reprendre',''),provider:'TEMU'};
 if(text==='TEMU · Lecture en attente')return {...result('temu-read-deferred','Lecture TEMU en attente',''),provider:'TEMU'};
 if(/achat d[’']étiquette TEMU à confirmer/i.test(text))return result('temu-purchase-confirmation','Achat d’étiquette TEMU à confirmer','');
 if(/^rapprochement requis, aucune nouvelle cr[ée]ation automatique\.?$/i.test(text))return result('erp-review','Erplain · Rapprochement requis avant nouvelle création','');
 if(/^GLS · (?:Aucun numéro de suivi PROD utilisable\.|Numéro de suivi absent pour le colis principal\.)/.test(text))return {...result('uncertain','GLS · Numéro de suivi à vérifier',''),provider:'GLS'};
 if(/^Client Erplain · Création à vérifier/.test(text))return result('customer','Client Erplain · Création à vérifier','');
 if(/^deadlock detected$/i.test(text))return result('erp-review','V3 · Conflit temporaire de traitement','');
 if(/^Préparation Erplain en attente ou en cours$/.test(text))return result('preparation-pending',text,'');
 if(["Échec d’étiquette antérieur, suivi d’une revalidation BC/BL. Aucune relance effectuée.","Échec d’étiquette antérieur : champs Erplain relus et validés. Aucune relance effectuée.","Appels d’offres · GLS Pharma obligatoire : actualiser la préparation selon les règles transporteurs"].includes(text))return result('preparation',text,'');
 if(/TEMU/i.test(text)&&/3000032|prix et TVA|Prix et frais de livraison|Données financières|Prix API à récupérer/i.test(text))return result('temu-pricing','TEMU · Prix à renseigner','');
 if(/^Reprendre le remplacement après correction/.test(text)||text==='Reprendre le remplacement : nouvelle vérification nécessaire')return result('equivalent-pending','Vérifier le remplacement');
 if(/^Produit équivalent vérifié/.test(text))return result('equivalent-pending','Appliquer le remplacement');
 if(/^Produit (?:équivalent|restant) \[[^\]]+\] : Poids vérifié, remplacement à confirmer$/.test(text))return result('equivalent-pending','Appliquer le remplacement');
 if(/Commande (modifiée|annulée|déjà expédiée)/i.test(text))return result('platform',/annulée/i.test(text)?'Commande annulée sur la plateforme':/déjà expédiée/i.test(text)?'Commande déjà expédiée sur la plateforme':'Commande modifiée sur la plateforme','');
 if(code==='401'||code==='403')return result('api-access','API '+apiName+' · Accès refusé ('+code+')','');
 if(code==='429'||/^\s*429\b|\b(?:status(?:\s+code)?|code|error|erreur)\s*[:=]?\s*429\b|\btoo many requests\b/i.test(text))return result('api-limit','API '+apiName+' · Limite atteinte (429)','');
 if(code&&Number(code)>=500)return result('api-server','API '+apiName+' · Erreur serveur ('+code+')','');
 if(/timeout|timed out|délai.*dépass|AbortError/i.test(text))return result('api-timeout','API '+apiName+' · Délai dépassé','');
 if(/injoignable|Connexion.*impossible|fetch failed|réseau|certificat/i.test(text))return result('api-network','API '+apiName+' · Connexion impossible','');
 if(/Stock non vérifiable|stock non reçu/i.test(text))return result('api-stock','Stock Erplain à vérifier');
 if(/API.*non reçue|Réponse.*incomplète/i.test(text))return result('api-incomplete','API '+apiName+' · Réponse incomplète','');
 if((!text.includes(';')&&text.startsWith("Erplain LIVE · Informations obligatoires manquantes : "))||["Erplain LIVE · Numéro de téléphone invalide : corriger avant création de l’étiquette","Erplain LIVE · Pays ou code postal invalide"].includes(text))return {...result('unknown',text,''),provider:'Erplain'};
 if(/Correspondance SKU (?:absente|introuvable)|Mapping.*(?:manquant|introuvable|absent)/i.test(text))return result('mapping','Mapping manquant');
 if(/Plusieurs produits|Produit Erplain ambigu|SKU en doublon|SKU Erplain(?: LIVE| TEST)? ambigu/i.test(text))return result('duplicate','SKU en doublon dans Erplain',sku||text.match(/SKU Erplain(?: LIVE| TEST)? ambigu\s*:\s*(.+)$/i)?.[1]?.trim()||'');
 if(/inactif/i.test(text)&&!/absent ou|introuvable ou/i.test(text))return result('inactive','Inactif dans Erplain');
 if(/Produit.*introuvable|SKU\s+Erplain(?:\s+(?:LIVE|TEST))?\s+(?:introuvable|absent)|SKU absent ou inactif|Aucun produit actif/i.test(text))return result('missing','SKU Erplain introuvable',sku||text.match(/(?:introuvable|absent(?: ou inactif)?)\s*:\s*(.+?)\s*$/i)?.[1]?.trim()||'');
 if(/Poids non exploitable/i.test(text))return result('weight','Poids trop faible');
 if(text==='Reprise historique à vérifier : BL non créé')return result('historical-preparation',text,'');
 if(/Étiquette existante sans (BC|BL) Erplain/i.test(text))return result('preparation',/sans BC/.test(text)?'BC Erplain non créé':'BL Erplain non créé','');
 if(/City-to-Postal Code mapping/i.test(text))return result('city','GOFO · Ville / code postal refusés','');
 if(/Unité de poids/i.test(text))return result('weight-unit','Unité de poids invalide');
 if(text==='Poids ou nombre de colis absent')return result('parcel-preparation','Poids du colis / nombre de colis à vérifier','');
 if(/synchronisation Erplain/i.test(text))return result('catalog-sync','Catalogue Erplain à synchroniser');
 if(/Poids.*(?:non renseigné|manquant|absent)/i.test(text))return result('weight','Poids manquant');
 // Legacy gate messages include hypothetical override guidance, not a shortage.
 if(/^Étiquette bloquée : contrôle du stock et BL validé requis\./i.test(text)||/^Validation stock \/ BL à (?:effectuer|actualiser)$/.test(text))return result('preparation','Validation stock / BL à actualiser','');
 if(/stock(?:\s+cumulé)?\s+insuffisant/i.test(text)){const stockSku=text.match(/^(?:Préparation V3 à vérifier · )?(?:BL bloqué [—-] stock insuffisant|Stock insuffisant) : ([^:;]+) : [\d.,]+ nécessaires/i)?.[1]?.trim()||text.match(/^Stock cumulé insuffisant\s*:\s*([^:;]+)$/i)?.[1]?.trim();return result('stock','Bloqué : stock insuffisant',stockSku||sku);}
 if(/BC existant contient d’autres|Commande V3 et BC différents|Écart BC\/BL|BC modifié/i.test(text))return result('bc','Commande V3 et BC différents');
 if(/^BC · Produits ou quantités des lignes Erplain différents de la source$/.test(text))return result('bc','Commande V3 et BC différents','');
 if(/Mode Shopify|Règle transport.*manquante|Gestionnaire transport à configurer/i.test(text))return result('routing',(/Shopify/i.test(text)?'Shopify · ':'')+'Règle transport manquante','');
 if(/Aucun point relais|Aucun relais/i.test(text))return result('relay','GLS · Aucun relais trouvé','');
 if(/ParcelShopID.*manquant/i.test(text))return result('relay-search','GLS · Recherche du relais','');
 if(/City information is incorrect/i.test(text))return result('city','GOFO · Ville refusée','');
 if(/Informations transport manquantes/i.test(text)){const field=text.split(':').slice(1).join(':').trim();return result('address',field?field+' manquant'+(field.includes(',')?'s':''):'Adresse manquante','');}
 if(/^Client Erplain/.test(text)&&/cr[e\u00e9]ation/i.test(text))return result('customer','Client Erplain \u00b7 Cr\u00e9ation \u00e0 v\u00e9rifier','');
 if(/^BC Erplain · Création à vérifier/.test(text))return result('bc','BC · Création à vérifier','');
 if(/^BL Erplain · Publication à vérifier/.test(text))return result('erplain-recovery','BL · Publication à vérifier','');
 if(/^Incident temporaire Erplain persistant après 3 reprises/.test(text))return result('erplain-recovery','Erplain · Reprise à vérifier après 3 tentatives','');
 if(/^Stock Erplain · Mouvement à vérifier/.test(text))return result('preparation','Stock · Mouvement à vérifier','');
 if(/incertaine|interrompu.*transporteur|Création.*vérifier/i.test(text))return result('uncertain',apiName+' · Création à vérifier','');
 if(/PDF.*attend|PDF.*attente/i.test(text))return result('pdf',apiName+' · PDF en attente','');
 if(code)return result('api-http',apiName+' · HTTP '+code+(/aucun motif|réponse vide|sans motif/i.test(text)?', motif inconnu':''),'');
 if(/Validation stock\/BL absente|Validation de la préparation|Préparation modifiée|Statut BC\/BL modifié|contrôle du stock et BL validé requis/i.test(text))return result('preparation','Validation stock / BL à actualiser','');
 // Preserve the recorded reason even when no dedicated classifier exists.
 if(/Order Creation Exception/i.test(text))return result('unknown',apiName+' · Échec création'+(text.match(/\b(\d{6,})\b/)?.[1]?' ('+text.match(/\b(\d{6,})\b/)[1]+')':''),'');
 if(/Traitement interrompu : rapprocher les documents/i.test(text))return result('unknown','Erplain · Traitement interrompu, documents à vérifier','');
 if(/Intervention interrompue/i.test(text))return result('unknown','Intervention interrompue · Vérification requise','');
 if(/The type field is required/i.test(text))return result('unknown','API '+apiName+' · Champ « type » requis');
 if(/Adresse : caractères refusés|shipping address contains non-English characters/i.test(text))return result('unknown','TEMU · Adresse : caractères refusés','');
 if(/Circuit TEMU achat séparé/i.test(text))return result('unknown','TEMU · Utiliser le circuit d’achat TEMU','');
 if(/Référence Erplain absente ou ambiguë/i.test(text))return result('unknown','Référence Erplain non identifiée',sku||text.split(':').slice(1).join(':').trim());
 const readable=text.replace(/\s+/g,' ').trim();
 const fallback=result('unknown',readable?(readable.length>120?readable.slice(0,117)+'…':readable):'Blocage sans motif enregistré');if(!readable)fallback.detail='Le traitement indique un blocage, mais aucun motif détaillé n’a été enregistré. Consultez les documents et l’historique avant toute reprise ; l’absence de motif ne prouve pas que le problème est résolu.';return fallback;
}
// Presentation only: never rewrite Error.message, which recovery policies inspect.
function displayErrorMessage(error,provider='Erplain'){
 const raw=String(error?.message??error??'');
 const apiName=error?.provider||provider;
 if(error?.code==='API_NETWORK_ERROR')return 'API '+apiName+' · Connexion impossible';
 if(error?.code==='API_READ_TIMEOUT')return 'API '+apiName+' · Délai dépassé';
 const status=Number(error?.httpStatus??error?.status);
 const input=status>=400&&status<=599?'HTTP '+status+' · '+raw:raw;
 const problem=compactProblem(input,'',apiName);
 return problem.type==='unknown'?raw:problem.label;
}
// Detailed panels keep actionable provider information visible, not only in a tooltip.
function displayErrorDetail(error,provider='Erplain'){
 const raw=String(error?.message??error??''),label=displayErrorMessage(error,provider);
 return raw&&raw!==label?label+' · '+raw:label;
}
function errorDetailsHtml(error,provider='Erplain'){
 const raw=String(error?.message??error??''),label=displayErrorMessage(error,provider);
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return escape(label)+(raw&&raw!==label?'<span class="error-detail" title="'+escape(raw)+'" aria-label="Détail de l’erreur : '+escape(raw)+'"> ⓘ</span>':'');
}
function problemMentionsSku(text,sku){
 const escaped=String(sku).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return !!sku&&new RegExp('(^|[^A-Za-z0-9_.-])'+escaped+'(?=$|[^A-Za-z0-9_.-])').test(String(text));
}
function compactProblemParts(raw){
 const parts=[];
 for(const part of String(raw).split(/\s;\s/)){
  if(parts.length&&/Incident de concurrence Erplain/i.test(parts[parts.length-1])&&/^ne répétez pas l[’']enregistrement\.?$/i.test(part.trim()))parts[parts.length-1]+=' ; '+part;
  else if(parts.length&&/stock insuffisant/i.test(parts[parts.length-1])&&/^(?:stock disponible|quantité (?:totale nécessaire|manquante))\s*:/i.test(part))parts[parts.length-1]+=' ; '+part;
  else parts.push(part);
 }
 return parts;
}
function hasCompleteOrderDocuments(order){
 if(order.complete_order_documents===true)return true;
 if(order.partial_mode)return false;
 const identified=document=>document&&String(document.id??'').trim()!=='';
 return identified(order.erp_live?.bc)&&
  (identified(order.erp_live?.bl)||(Array.isArray(order.erplain_tracking_bls)&&order.erplain_tracking_bls.some(identified)))&&
  (Number(order.document_count)>0||(Array.isArray(order.temu_documents)&&order.temu_documents.length>0));
}
function compactProblems(order){
 if(isDeliveredOrder(order))return [];
 // Human instruction 2026-10-12: BC + BL + existing label closes blocking messages only.
 if(hasCompleteOrderDocuments(order))return [];
 if(order.archived||order.suspension?.active===true||order.label_status==='cancelled'||order.tracking_status==='cancelled'||order.erp_live?.bc?.status==='cancelled'||order.suspension?.erplainCancellation?.status==='complete')return [];
 const lines=order.sku_lines||[],out=[],family=order.carrier?.startsWith('gls')?'GLS':order.carrier==='gofo'?'GOFO':order.carrier==='temu'?'TEMU':'Erplain';
 const hiddenBcStockWait='En attente de stock : BC disponible, préparation du BL suspendue';
 const add=p=>{if(p.detail===hiddenBcStockWait)return;if(order.erp_live?.phase==='historical_review'&&order.erp_live.bc?.id&&!order.erp_live.bl?.id&&p.detail==='BC · Prix, remises ou écotaxes des lignes Erplain différents de la source')p={...p,type:'historical-preparation'};const same=out.find(x=>x.sku===p.sku&&x.type===p.type&&x.provider===p.provider&&(x.detail===p.detail||['mapping','missing','inactive','duplicate','weight','weight-unit','stock','customer'].includes(p.type)));if(!same)out.push(p);else if(same.detail!==p.detail&&!same.detail.includes(p.detail)){if(p.detail.includes(same.detail))same.detail=p.detail;else same.detail+='\n'+p.detail;}};
 const pending=order.pending_equivalent;const pendingLine=pending&&lines.find(l=>[l.sku,l.mapped_sku,l.source_sku].includes(pending.sku));
 if(pendingLine&&pending.error){const p=compactProblem(pending.error,pending.replacementSku);p.detail='Remplacement prévu : '+pending.sku+' → '+pending.replacementSku+' · '+p.detail;add(p);}
 for(const l of lines){const sku=l.sku||l.mapped_sku||l.source_sku;if(l.catalog_issue)add(compactProblem(l.catalog_issue,sku));if(!['tender','samples','temu'].includes(order.channel)&&l.mapping_exists===false&&!l.sku)add(compactProblem('Mapping manquant',l.source_sku));}
 for(const [raw,provider]of [[order.resolution_error,'Erplain'],[order.issue,/Transporteur|GLS|GOFO/i.test(order.issue||'')?family:'Erplain'],[order.erp_live_job?.error,'Erplain'],[order.carrier_job?.error,family],[order.source_payload?.externalLabel?.active||order.transport_choice&&!['uncertain','purchasing','cancelled','cancellation_requested','not_to_ship'].includes(order.temu_job?.status)?null:order.temu_job?.error,'TEMU']]){if(!raw)continue;for(let part of compactProblemParts(raw)){if(/stock insuffisant/i.test(raw)&&!/stock insuffisant/i.test(part)&&/:\s*[\d.,]+\s+n[ée]cessaires?/i.test(part))part='Stock insuffisant : '+part;const relevant=lines.filter(l=>[l.sku,l.source_sku].filter(Boolean).some(s=>problemMentionsSku(part,s)));if(relevant.length)for(const l of relevant)add(compactProblem(part,l.sku||l.source_sku,provider));else add(compactProblem(part,'',provider));}}
 const temuAwaitingPurchase=order.channel==='temu'&&!order.source_payload?.externalLabel?.active&&!order.transport_choice&&!order.partial_mode&&!order.resolution_active&&!order.resolution_pending_resume&&!order.carrier_job?.status&&order.temu_job?.status==='ready'&&!order.temu_job?.error&&order.erp_live_job?.status==='complete'&&order.erp_live?.phase==='bl_ready';
 if(order.source_payload?.temuReadDeferred?.deferred===true){const deferred=out.filter(p=>p.type==='temu-read-deferred');if(deferred.length)for(const p of deferred)p.label='Lecture TEMU en attente';else add(compactProblem('TEMU · Lecture en attente','','TEMU'));}
 if(!out.length&&order.replacement_preparation)add({type:'preparation-pending',label:order.replacement_preparation.message,sku:order.replacement_preparation.products.map(p=>p.sku).join(', '),detail:'Le remplacement est enregistré dans le BC. La préparation du BL reste '+(order.replacement_preparation.status==='processing'?'en cours':'en attente')+' ; le stock actuel sera contrôlé avant préparation.',provider:'Erplain'});
 if(!out.length&&['temu','amazon','shopify'].includes(order.channel)&&!order.erp_live?.bc?.id&&order.erp_live_job?.status==='review'&&!order.erp_live_job.error&&!order.resolution_pending_resume)add({type:'bc-preparation',label:'BC non créé : reprise en attente',sku:'',detail:'Le traitement du bon de commande est arrêté sans motif actif. La reprise doit être rapprochée de son historique ; le statut de la plateforme ne bloque pas la création du BC.',provider:'Erplain'});
 if(!out.length&&!order.label_manual_request_required&&!order.manual_label_request&&!temuAwaitingPurchase&&['blocked','waiting_catalog','review','failed'].includes(order.carrier_job?.status||order.label_status))add(order.resolution_pending_resume&&!order.resolution_active?{type:'unknown',label:'Reprise à demander',sku:'',detail:'Des corrections sont enregistrées et la reprise de la préparation reste à demander. Consultez les documents et les diagnostics actuels avant toute reprise ; cet état ne confirme pas que tous les blocages sont résolus.',provider:'Erplain'}:compactProblem(''));
 // Historical job errors do not invalidate a mapping present on the current lines.
 const visible=out.filter(p=>{
  if(pendingLine&&pending.recheckRequired&&p.detail===pending.previousError)return false;
  if(!p.sku&&(p.type==='weight'||p.type==='stock'&&new Set(lines.map(l=>l.sku||l.mapped_sku||l.source_sku).filter(Boolean)).size===1)&&out.some(x=>x.type===p.type&&x.sku&&x.label===p.label))return false;
  if(pendingLine&&!pending.recheckRequired&&p.sku===pending.sku&&Number(pending.replaceQuantity)>=Number(pendingLine.quantity)&&Number(pendingLine.quantity)>0&&['weight','weight-unit','stock','missing','inactive','duplicate'].includes(p.type))return false;
  if(pendingLine&&!p.sku&&p.detail===pending.error)return false;
  if(p.type!=='mapping')return true;
  const relevant=lines.filter(l=>[l.source_sku,l.sku,l.mapped_sku].filter(Boolean).some(s=>s===p.sku||problemMentionsSku(p.detail,s)));
  const affected=relevant.length?relevant:lines;
  return !affected.length||affected.some(l=>!l.mapping_exists&&!l.mapping_resolved);
 });
 if(!visible.length&&!order.open_bl_diagnostic_retired&&order.erp_status==='live_review'&&order.erp_live_job?.status!=='complete')visible.push({type:'erp-review',label:'Erplain · Préparation à vérifier',sku:'',detail:'Préparation Erplain à vérifier. Aucun motif détaillé applicable à la commande actuelle n’est disponible. Consultez le BC, les BL et l’historique du traitement avant toute reprise ; cet état ne confirme pas que les blocages sont résolus.',provider:'Erplain'});
 return visible;
}
function compactProblemButtons(order){const list=compactProblems(order),id=esc(order.id);return list.slice(0,2).map(p=>'<button class="badge warn compact-problem" data-exact-problem="'+id+'" data-stock-channel="'+esc(order.channel||'')+'" data-problem-type="'+esc(p.type)+'" data-problem-sku="'+esc(p.sku)+'" data-problem-detail="'+esc(p.detail)+'" title="'+esc((p.sku?p.sku+' · ':'')+(p.detail||p.label))+'">'+(p.sku?'<span>'+esc(p.sku)+'</span>':'')+'<span>'+esc(p.label)+'</span></button>').join('')+(list.length>2?'<button class="link-button" data-exact-problem="'+id+'">+'+(list.length-2)+' problèmes</button>':'');}
transportPendingText=function(order){if(isDeliveredOrder(order))return 'Livrée · aucun problème à gérer';const weight=Number(order.weight_kg),extraReady=(order.extra_parcels||[]).filter(p=>p.status==='ready').length,parcels=extraReady&&order.document_count?Number(order.document_count)+extraReady:Number(order.parcel_count);if(Number.isFinite(weight)&&weight>0)return Number(weight.toPrecision(12))+' kg · '+(Number.isInteger(parcels)&&parcels>0?parcels+' colis':'nombre de colis à confirmer');if(order.channel==='temu'&&order.temu_job?.status==='ready'&&!order.temu_documents?.length)return 'Achat TEMU à confirmer';if(compactProblems(order).some(p=>p.type==='stock'))return 'Préparation arrêtée : stock insuffisant';return 'Préparation à compléter';};


if(typeof orderProblemText==='function'){const previousOrderProblemText=orderProblemText;orderProblemText=function(order){return isDeliveredOrder(order)||hasCompleteOrderDocuments(order)?'':previousOrderProblemText(order);};}
