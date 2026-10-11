function compactProblem(raw,sku='',provider='Erplain') {
 const text=String(raw||'');const explicitSku=text.match(/^(?:Produit équivalent|Produit restant|Produit de remplacement) \[([^\]]+)\] : /)?.[1];if(explicitSku)sku=explicitSku;const code=text.match(/(?:HTTP\s*|\()(\d{3})(?:\)|\b)/i)?.[1];
 const result=(type,label,s=sku)=>({type,label,sku:s,detail:text,provider:apiName});
 const apiName=/GOFO/i.test(text)?'GOFO':/GLS/i.test(text)?'GLS':/TEMU/i.test(text)?'TEMU':/Shopify/i.test(text)?'Shopify':provider;
 if(/Étiquette refusée par TEMU|TEMU.*Étiquette refusée/i.test(text))return result('temu-label-refused','Étiquette refusée par TEMU','');
 if(/^(?:TEMU · )?Quota partagé : lecture différée$/.test(text))return {...result('temu-read-deferred','Lecture TEMU à reprendre',''),provider:'TEMU'};
 if(text==='TEMU · Lecture en attente')return {...result('temu-read-deferred','Lecture TEMU en attente',''),provider:'TEMU'};
 if(/achat d[’']étiquette TEMU à confirmer/i.test(text))return result('temu-purchase-confirmation','Achat d’étiquette TEMU à confirmer','');
 if(/^Préparation Erplain en attente ou en cours$/.test(text))return result('preparation-pending',text,'');
 if(["Échec d’étiquette antérieur, suivi d’une revalidation BC/BL. Aucune relance effectuée.","Échec d’étiquette antérieur : champs Erplain relus et validés. Aucune relance effectuée.","Appels d’offres · GLS Pharma obligatoire : actualiser la préparation selon les règles transporteurs"].includes(text))return result('preparation',text,'');
 if(/TEMU/i.test(text)&&/3000032|prix et TVA|Prix et frais de livraison|Données financières|Prix API à récupérer/i.test(text))return result('temu-pricing','TEMU · Prix à renseigner','');
 if(/^Reprendre le remplacement après correction/.test(text))return result('equivalent-pending','Vérifier le remplacement');
 if(/^Produit équivalent vérifié/.test(text))return result('equivalent-pending','Confirmer le remplacement');
 if(/^Produit (?:équivalent|restant) \[[^\]]+\] : Poids vérifié, remplacement à confirmer$/.test(text))return result('equivalent-pending','Confirmer le remplacement');
 if(/Commande (modifiée|annulée|déjà expédiée)/i.test(text))return result('platform',/annulée/i.test(text)?'Commande annulée sur la plateforme':/déjà expédiée/i.test(text)?'Commande déjà expédiée sur la plateforme':'Commande modifiée sur la plateforme','');
 if(code==='401'||code==='403')return result('api-access','API '+apiName+' · Accès refusé ('+code+')','');
 if(code==='429')return result('api-limit','API '+apiName+' · Limite atteinte (429)','');
 if(code&&Number(code)>=500)return result('api-server','API '+apiName+' · Erreur serveur ('+code+')','');
 if(/timeout|timed out|délai.*dépass|AbortError/i.test(text))return result('api-timeout','API '+apiName+' · Délai dépassé','');
 if(/injoignable|Connexion.*impossible|fetch failed|réseau|certificat/i.test(text))return result('api-network','API '+apiName+' · Connexion impossible','');
 if(/Stock non vérifiable|stock non reçu/i.test(text))return result('api-stock','API Erplain : stock non reçu');
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
 if(/stock insuffisant/i.test(text))return result('stock','Bloqué : stock insuffisant');
 if(/BC existant contient d’autres|Commande V3 et BC différents|Écart BC\/BL|BC modifié/i.test(text))return result('bc','Commande V3 et BC différents');
 if(/^BC · Produits ou quantités des lignes Erplain différents de la source$/.test(text))return result('bc','Commande V3 et BC différents','');
 if(/Mode Shopify|Règle transport.*manquante|Gestionnaire transport à configurer/i.test(text))return result('routing',(/Shopify/i.test(text)?'Shopify · ':'')+'Règle transport manquante','');
 if(/Aucun point relais|Aucun relais/i.test(text))return result('relay','GLS · Aucun relais trouvé','');
 if(/ParcelShopID.*manquant/i.test(text))return result('relay-search','GLS · Recherche du relais','');
 if(/City information is incorrect/i.test(text))return result('city','GOFO · Ville refusée','');
 if(/Informations transport manquantes/i.test(text)){const field=text.split(':').slice(1).join(':').trim();return result('address',field?field+' manquant'+(field.includes(',')?'s':''):'Adresse manquante','');}
 if(/^BC Erplain · Création à vérifier/.test(text))return result('bc','BC · Création à vérifier','');
 if(/^BL Erplain · Publication à vérifier/.test(text))return result('preparation','BL · Publication à vérifier','');
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
function compactProblems(order){
 if(order.archived||order.label_status==='cancelled'||order.tracking_status==='cancelled')return [];
 const lines=order.sku_lines||[],out=[],family=order.carrier?.startsWith('gls')?'GLS':order.carrier==='gofo'?'GOFO':order.carrier==='temu'?'TEMU':'Erplain';
 const add=p=>{if(order.erp_live?.phase==='historical_review'&&order.erp_live.bc?.id&&!order.erp_live.bl?.id&&p.detail==='BC · Prix, remises ou écotaxes des lignes Erplain différents de la source')p={...p,type:'historical-preparation'};const same=out.find(x=>x.sku===p.sku&&x.type===p.type&&x.provider===p.provider&&(x.detail===p.detail||['mapping','missing','inactive','duplicate','weight','weight-unit','stock'].includes(p.type)));if(!same)out.push(p);else if(same.detail!==p.detail&&!same.detail.includes(p.detail)){if(p.detail.includes(same.detail))same.detail=p.detail;else same.detail+='\n'+p.detail;}};
 const pending=order.pending_equivalent;const pendingLine=pending&&lines.find(l=>[l.sku,l.mapped_sku,l.source_sku].includes(pending.sku));
 if(pendingLine&&pending.error){const p=compactProblem(pending.error,pending.replacementSku);p.detail='Remplacement prévu : '+pending.sku+' → '+pending.replacementSku+' · '+p.detail;add(p);}
 for(const l of lines){const sku=l.sku||l.mapped_sku||l.source_sku;if(l.catalog_issue)add(compactProblem(l.catalog_issue,sku));if(!['tender','samples','temu'].includes(order.channel)&&l.mapping_exists===false&&!l.sku)add(compactProblem('Mapping manquant',l.source_sku));}
 for(const [raw,provider]of [[order.resolution_error,'Erplain'],[order.issue,/Transporteur|GLS|GOFO/i.test(order.issue||'')?family:'Erplain'],[order.erp_live_job?.error,'Erplain'],[order.carrier_job?.error,family],[order.source_payload?.externalLabel?.active||order.transport_choice&&!['uncertain','purchasing','cancelled','cancellation_requested','not_to_ship'].includes(order.temu_job?.status)?null:order.temu_job?.error,'TEMU']]){if(!raw)continue;for(let part of compactProblemParts(raw)){if(/stock insuffisant/i.test(raw)&&!/stock insuffisant/i.test(part)&&/:\s*[\d.,]+\s+n[ée]cessaires?/i.test(part))part='Stock insuffisant : '+part;const relevant=lines.filter(l=>[l.sku,l.source_sku].filter(Boolean).some(s=>problemMentionsSku(part,s)));if(relevant.length)for(const l of relevant)add(compactProblem(part,l.sku||l.source_sku,provider));else add(compactProblem(part,'',provider));}}
 const temuAwaitingPurchase=order.channel==='temu'&&!order.source_payload?.externalLabel?.active&&!order.transport_choice&&!order.partial_mode&&!order.resolution_active&&!order.resolution_pending_resume&&!order.carrier_job?.status&&order.temu_job?.status==='ready'&&!order.temu_job?.error&&order.erp_live_job?.status==='complete'&&order.erp_live?.phase==='bl_ready';
 if(order.source_payload?.temuReadDeferred?.deferred===true){const deferred=out.filter(p=>p.type==='temu-read-deferred');if(deferred.length)for(const p of deferred)p.label='Lecture TEMU en attente';else add(compactProblem('TEMU · Lecture en attente','','TEMU'));}
 if(!out.length&&!temuAwaitingPurchase&&['blocked','waiting_catalog','review','failed'].includes(order.carrier_job?.status||order.label_status))add(order.resolution_pending_resume&&!order.resolution_active?{type:'unknown',label:'Reprise à demander',sku:'',detail:'Des corrections sont enregistrées et la reprise de la préparation reste à demander. Consultez les documents et les diagnostics actuels avant toute reprise ; cet état ne confirme pas que tous les blocages sont résolus.',provider:'Erplain'}:compactProblem(''));
 // Historical job errors do not invalidate a mapping present on the current lines.
 const visible=out.filter(p=>{
  if(!p.sku&&(p.type==='weight'||p.type==='stock'&&new Set(lines.map(l=>l.sku||l.mapped_sku||l.source_sku).filter(Boolean)).size===1)&&out.some(x=>x.type===p.type&&x.sku&&x.label===p.label))return false;
  if(pendingLine&&p.sku===pending.sku&&Number(pending.replaceQuantity)>=Number(pendingLine.quantity)&&Number(pendingLine.quantity)>0&&['weight','weight-unit','stock','missing','inactive','duplicate'].includes(p.type))return false;
  if(pendingLine&&!p.sku&&p.detail===pending.error)return false;
  if(p.type!=='mapping')return true;
  const relevant=lines.filter(l=>[l.source_sku,l.sku,l.mapped_sku].filter(Boolean).some(s=>s===p.sku||problemMentionsSku(p.detail,s)));
  const affected=relevant.length?relevant:lines;
  return !affected.length||affected.some(l=>!l.mapping_exists&&!l.mapping_resolved);
 });
 if(!visible.length&&order.erp_status==='live_review'&&order.erp_live_job?.status!=='complete')visible.push({type:'erp-review',label:'Erplain · Préparation à vérifier',sku:'',detail:'Préparation Erplain à vérifier. Aucun motif détaillé applicable à la commande actuelle n’est disponible. Consultez le BC, les BL et l’historique du traitement avant toute reprise ; cet état ne confirme pas que les blocages sont résolus.',provider:'Erplain'});
 return visible;
}
function compactProblemButtons(order){const list=compactProblems(order),id=esc(order.id);return list.slice(0,2).map(p=>'<button class="badge warn compact-problem" data-exact-problem="'+id+'" data-problem-type="'+esc(p.type)+'" data-problem-sku="'+esc(p.sku)+'" data-problem-detail="'+esc(p.detail)+'" title="'+esc((p.sku?p.sku+' · ':'')+(p.detail||p.label))+'">'+(p.sku?'<span>'+esc(p.sku)+'</span>':'')+'<span>'+esc(p.label)+'</span></button>').join('')+(list.length>2?'<button class="link-button" data-exact-problem="'+id+'">+'+(list.length-2)+' problèmes</button>':'');}
transportPendingText=function(order){const weight=Number(order.weight_kg),parcels=Number(order.parcel_count);if(Number.isFinite(weight)&&weight>0)return Number(weight.toPrecision(12))+' kg · '+(Number.isInteger(parcels)&&parcels>0?parcels+' colis':'nombre de colis à confirmer');if(order.channel==='temu'&&order.temu_job?.status==='ready'&&!order.temu_documents?.length)return 'Achat TEMU à confirmer';if(compactProblems(order).some(p=>p.type==='stock'))return 'Préparation arrêtée : stock insuffisant';return 'Préparation à compléter';};

