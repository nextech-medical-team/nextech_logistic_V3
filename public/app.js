// The platform declaration is an independent, indicative observation.
function logisticsReadHtml(o){
 const parcels=o.logistics_observation?.parcels||[],dates=parcels.map(p=>Date.parse(p.checkedAt)).filter(Number.isFinite);
 if(!dates.length)return '';
 const date=new Date(Math.min(...dates)).toLocaleString('fr-FR');
 return '<small>Lecture des colis : '+esc(date)+(parcels.some(p=>p.stale)?' · lecture ancienne':'')+'</small>';
}
function platformStatusHtml(o){
 const v=o.platform_status||{},raw=v.status;
 const temuLabels={'1':'En attente','2':'À expédier','3':'Annulée','4':'Expédiée','5':'Reçue','41':'Partiellement expédiée','51':'Partiellement reçue'};
 const isTemu=v.channel==='temu',hasCode=raw!==null&&raw!==undefined&&String(raw).trim()!=='';
 const text=v.channel==='shopify'?({unfulfilled:'Non expédiée',fulfilled:'Expédiée',partial:'Partiellement expédiée',partially_fulfilled:'Partiellement expédiée'})[raw]||raw:isTemu?(hasCode?'Code '+raw:'Statut TEMU indisponible'):raw;
 const message=isTemu&&hasCode?'<br><span data-temu-status-label>'+esc(temuLabels[String(raw)]||'Statut non reconnu')+'</span>':'';
 return '<span class="badge" title="Information du canal de vente, sans effet sur la préparation. Le suivi logistique indique l’évolution physique du colis.">'+esc(text||'Statut non renseigné')+message+esc(!isTemu&&v.cancelled?' · Annulée':'')+esc(v.financialStatus==='refunded'?' · Remboursée':'')+'</span><small>'+esc(v.observedAt?'Lu le '+new Date(v.observedAt).toLocaleString('fr-FR'):'Date de lecture non disponible')+'</small>'+(v.error?'<small>Lecture indisponible · dernière observation conservée</small>':'');
}

function erplainTrackingHtml(o){
 const bls=o.erplain_tracking_bls||[];
 return bls.length?bls.map(b=>'<span class="erp-status">'+esc(b.label||b.id||'BL')+' · '+esc(erpStatusText(b.status))+'</span>').join('<br>'):'<span class="badge">BL non créé</span>';
}
function erplainDisplayLines(o){return o.source_payload?.erplainImported===true&&o.source_payload?.account==='live'&&!o.partial_mode&&Array.isArray(o.sku_lines)?o.sku_lines:o.erp_live?.documentSource?.lines;}
function canRestartCancelledDelivery(o){return !o.partial_mode&&!!o.erp_live?.bc?.id&&o.erp_live.bc.status==='active'&&o.erp_live?.bl?.status==='cancelled'&&!['temu','relay'].includes(o.channel);}
let partialVisibleOrders=new Map();
function erplainBlHistoryHtml(o){const bls=o.erp_live?.documentSource?.shippingOrders||o.erp_live?.bc?.shipping_orders?.data||[],holds=o.erp_live?.documentSource?.stockHolds||o.erp_live?.partialSource?.stockHolds||[];return (bls.length?'<details><summary>'+bls.length+' BL associé(s)</summary>'+bls.map(b=>'<p>'+esc(b.label)+' · '+esc(erpStatusText(b.status))+'<small>'+(b.line_items||[]).filter(l=>l.variant).map(l=>esc(l.variant.sku)+' × '+esc(l.quantity)).join(' ; ')+'</small></p>').join('')+'</details>':'')+holds.map(h=>'<small role="alert">'+esc(h.bl)+' · '+esc(h.message)+cancelledStockRestoreHtml(o.id,h)+'</small>').join('');}
let orderSort='date',orderDirection='desc';

const $=id=>document.getElementById(id);

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let orderRequestVersion=0;

let preparedOrderResponse=null,orderRenderData=null;

let lastOrdersQuery='',lastOrdersSnapshot='',lastPartialSnapshot='',backgroundOrdersBusy=false;

function ordersSnapshot(r){return JSON.stringify({rows:r.rows,total:r.total,pages:r.pages,summary:r.summary,transportStats:r.transportStats});}

async function refreshOrdersQuietly(){

 if(backgroundOrdersBusy||!lastOrdersQuery||document.querySelector('dialog[open],[data-inline-editing],details.compact-filter[open]')||window.getSelection()?.toString())return false;

 backgroundOrdersBusy=true;const query=lastOrdersQuery,version=orderRequestVersion;

 try{const r=await api('/api/orders?'+query);if(currentView!=='orders'||version!==orderRequestVersion||query!==lastOrdersQuery)return;

 const ids=r.rows.map(o=>o.id);

 const [partial,diagnostics]=ids.length?await Promise.all([api('/api/partial/visible',{ids}),api('/api/erplain-refresh/diagnostics?ids='+encodeURIComponent(ids.join(',')))]):[{rows:[]},{rows:[]}];

 if(version!==orderRequestVersion||currentView!=='orders'||document.querySelector('dialog[open],[data-inline-editing],details.compact-filter[open]')||window.getSelection()?.toString())return;

 if(ordersSnapshot(r)!==lastOrdersSnapshot||JSON.stringify(partial.rows)!==lastPartialSnapshot||JSON.stringify(diagnostics.rows)!==JSON.stringify(orderRenderData?.diagnostics.rows||[])){preparedOrderResponse={query,r,partial,diagnostics};await orders();}

 return true;

 }finally{preparedOrderResponse=null;backgroundOrdersBusy=false;}

}

const orderManagers=new Map();

let page=1,pages=1,selected=new Set(),currentView='orders',user,setup=false;

// Classify transport failures; never automatically replay a mutation here.

async function api(url,data,options={}){

 let r,text;const duration=Number(options?.timeoutMs),timeoutMs=!data&&Number.isFinite(duration)&&duration>0?Math.min(duration,120000):0;const controller=timeoutMs?new AbortController():null;let deadline;if(controller)deadline=setTimeout(()=>controller.abort(),timeoutMs);

 try{r=await fetch(url,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:(controller?{signal:controller.signal}:{}));text=await r.text();}

 catch{if(controller?.signal.aborted)throw Object.assign(new Error('La lecture du statut a dépassé le délai. Le traitement enregistré reste à vérifier ; aucune nouvelle opération n’a été soumise.'),{code:'API_READ_TIMEOUT',retryable:true});throw Object.assign(new Error('Connexion à V3 interrompue. Le résultat de la demande doit être vérifié.'),{code:'API_NETWORK_ERROR',retryable:true});}finally{if(deadline)clearTimeout(deadline);}

 let result,valid=false;try{result=JSON.parse(text);valid=true;}catch{}

 if(!r.ok){

  const retryable=[502,503,504].includes(r.status);

  const fallback=retryable?'V3 temporairement indisponible (HTTP '+r.status+'). Réessayez dans quelques instants.':r.status===401?'Session expirée. Reconnectez-vous à V3.':r.status===403?'Votre accès ne permet pas cette action.':'La demande a échoué (HTTP '+r.status+').';

  throw Object.assign(new Error(valid&&typeof result?.error==='string'?result.error:fallback),{code:'API_HTTP_ERROR',status:r.status,retryable});

 }

 if(r.status===204)return {};

 if(!valid)throw Object.assign(new Error('Réponse V3 vide ou incomplète. Le résultat de la demande doit être vérifié.'),{code:'API_RESPONSE_INVALID',status:r.status,retryable:true});

 return result;

}

function flash(message,error=false){$('flash').hidden=false;$('flash').className=error?'error':'';$('flash').textContent=warningText(message);}

const labels={amazon:'Amazon',tender:'Appels d’offres',shopify:'Shopify',temu:'TEMU',pending:'En attente',connection_missing:'Connexion Erplain non configurée',waiting_catalog:'Poids Erplain en attente de récupération',blocked:'À compléter',simulated:'Simulation',simulated_only:'Simulé',simulated_pending:'Simulation en attente',not_due:'Non déclenchée',not_shipped:'Non expédiée',delivered_simulated:'Livraison simulée',unknown:'Statut inconnu',cancelled:'Annulée',shipped:'Expédiée',delivered:'Livrée',in_transit:'En acheminement',exception:'Incident de suivi',partial:'Livraisons partielles',production_pending:'Étiquette PROD en attente',production_ready:'Étiquette PROD prête',ready:'Prête',failed:'Échec'};

function badge(s){return `<span class="badge ${s==='blocked'?'warn':s==='delivered_simulated'?'green':''}" data-status="${esc(s??'')}">${esc(labels[s]||(s?'Statut non reconnu : '+s:'Statut non renseigné'))}</span>`;}
function skuCopyAction(o){const known=Number(o.document_count)>0||o.temu_documents?.length||(o.extra_parcels||[]).some(p=>p.status==='ready');return `<button class="link-button" data-sku-copy="${esc(o.id)}" title="${known?'Consulter le PDF existant ; toute modification exige une confirmation.':'Vérifier les PDF existants. Sans PDF, aucune modification, expédition ou achat ne sera proposé.'}">${known?'Actualiser les SKU sur l’étiquette — suivi inchangé':'Vérifier les étiquettes existantes'}</button>`;}

async function stats(){const s=await api('/api/dashboard');$('mapping-count').textContent=`${s.mappings.toLocaleString('fr-FR')} correspondances au total · 100 premiers résultats affichés`;

}

function selection(){ $('selection-count').textContent=`${selected.size} sélection${selected.size>1?'s':''}`;for(const id of ['tracking','deliver'])$(id).disabled=!selected.size;}

function orderFilterParams(requestedPage=1){
 const params=new URLSearchParams({page:requestedPage,pageSize:$('orders-page-size')?.value||50,search:$('search').value,sort:orderSort,direction:orderDirection});for(const key of ['channel','status','carrier','country','tracking-filter'])for(const v of [...$(key).selectedOptions].map(o=>o.value).filter(Boolean))params.append(key==='tracking-filter'?'tracking':key,v);for(const key of ['from','to'])if($(key).value)params.set(key,$(key).value);for(const option of [...($('problem-type')?.selectedOptions||[])])params.append('problem-label',option.value);
 return params;
}

async function orders(){

 if((document.querySelector('[data-inline-editing]')||(window.getSelection()?.toString()&&$('order-rows').contains(window.getSelection()?.anchorNode))))return;const requestVersion=++orderRequestVersion;

 const params=orderFilterParams(page);const packet=preparedOrderResponse?.query===params.toString()?preparedOrderResponse:null;preparedOrderResponse=null;

 const r=packet?.r||await api('/api/orders?'+params);

 const ids=r.rows.map(o=>o.id);

 // Fetch every asynchronous row enrichment before touching the visible table.

 const [partial,capacity,diagnostics]=await Promise.all([

 packet?.partial||(ids.length?api('/api/partial/visible',{ids}):Promise.resolve({rows:[]})),

 api('/api/erplain/live-capacity').catch(e=>({error:e.message})),

 packet?.diagnostics||(ids.length?api('/api/erplain-refresh/diagnostics?ids='+encodeURIComponent(ids.join(','))):Promise.resolve({rows:[]}))

 ]);

 if(requestVersion!==orderRequestVersion||currentView!=='orders'||document.querySelector('dialog[open]:not([data-allow-order-refresh="true"]),[data-inline-editing]')||(window.getSelection()?.toString()&&$('order-rows').contains(window.getSelection()?.anchorNode)))return;

 r.rows=r.rows.map(temuLabelDisplayOrder);
 partialVisibleOrders=new Map(r.rows.map(o=>[o.id,o]));
 orderRenderData={version:requestVersion,partial,capacity,diagnostics};

 if(requestVersion!==orderRequestVersion||(document.querySelector('[data-inline-editing]')||(window.getSelection()?.toString()&&$('order-rows').contains(window.getSelection()?.anchorNode))))return;lastOrdersQuery=params.toString();lastOrdersSnapshot=ordersSnapshot(r);if(!r.rows.length)lastPartialSnapshot='[]';pages=r.pages;if(typeof renderTransportStats==='function')renderTransportStats(r.transportStats||[],r.summary);for(const o of r.rows)orderManagers.set(o.id,o.account_manager||o.channel);

 $('order-rows').innerHTML=r.rows.length?r.rows.map(o=>`<tr data-complete-order-documents="${hasCompleteOrderDocuments(o)?'true':'false'}" class="${o.temu_job?.status==='cancelled'||o.erp_live?.bc?.status==='cancelled'||o.label_status==='cancelled'||o.tracking_status==='cancelled'?'order-cancelled':''}"><td><input type="checkbox" data-id="${esc(o.id)}" ${selected.has(o.id)?'checked':''} aria-label="Sélectionner ${esc(o.reference)}"></td><td><span class="link-button selectable-reference" role="button" tabindex="0" data-detail="${esc(o.id)}">${esc(o.reference)}</span><small data-suspension-order="${esc(o.id)}">${o.suspension?.active?'<strong>Commande suspendue · attente d’annulation client</strong><br>'+esc(o.suspension.note):''}<button type="button" class="link-button" data-order-suspension="${esc(o.id)}">${o.suspension?.active?'Voir la suspension / Réactiver':'Suspendre la commande'}</button></small><small>${esc(o.channel==='shopify'&&o.source_payload?.shopifyDeliveryMode==='relay'?'NEXTECH RELAIS':labels[o.channel]||o.channel)}</small></td><td data-order-date="${esc(o.source_date||'')}">${esc(o.source_date||'Date non fournie')}</td><td><span class="erp-reference" title="${esc(o.erp_live?.bc?.label||'Non créé')}">${esc(o.erp_live?.bc?.label||'—')}</span><small class="erp-status" data-status="${esc(o.erp_live?.bc?.status||'unknown')}">${o.erp_live?.bc?erpStatusText(o.erp_live.bc.status):o.erp_live_job?.status==='processing'?'Création en cours':/^creating/.test(o.erp_live?.phase||'')?'Création à vérifier':o.erp_live?.bcReconciliation?.status==='missing'?'Non retrouvé dans Erplain LIVE':'Non enregistré'}</small><button class="link-button" data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bc">Actualiser le BC Erplain</button>${!o.erp_live?.bc?.id&&o.erp_live_job?.status!=='processing'&&!o.resolution_active?'<button class="link-button" data-reconcile-bc="'+esc(o.id)+'">Vérifier le BC dans Erplain LIVE</button>':''}</td><td><span class="erp-reference" title="${esc(o.partial_mode?'BL par livraison':o.erp_live?.bl?.label||'Non créé')}">${o.partial_mode?'BL par livraison':esc(o.erp_live?.bl?.label||'—')}</span><small class="erp-status" data-status="${esc(o.erp_live?.bl?.status||'unknown')}">${o.erp_live?.bl?erpStatusText(o.erp_live.bl.status):'Non créé'}</small><button class="link-button" data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bl">Actualiser les BL Erplain</button>${erplainBlHistoryHtml(o)}</td><td>${esc(o.recipient||'À compléter')}<small>${esc(o.address?.country||'')} · ${esc(o.address?.city||'')} ${esc(o.address?.postal||'')}</small></td><td class="total-quantity-column">${esc((erplainDisplayLines(o)||o.partial_mode&&o.erp_live?.partialSource?.lines)?(erplainDisplayLines(o)||o.erp_live.partialSource.lines).reduce((n,l)=>n+Number(l.quantity),0):o.item_quantity??'—')}<small>${esc(erplainDisplayLines(o)?.length??o.line_count)} lignes</small></td><td>${((erplainDisplayLines(o)||o.partial_mode&&o.erp_live?.partialSource?.lines)?(erplainDisplayLines(o)||o.erp_live.partialSource.lines).map(l=>({sku:l.sku,quantity:l.quantity})):o.sku_lines||[]).map((l,i,lines)=>esc(skuColumnLineText(o,l,i,lines))).filter(Boolean).join('<br>')||'—'}</td><td>${o.partial_mode?'Transport par livraison':esc(o.source_payload?.externalLabel?.carrier||({gls:'GLS home',gls_pharma:'GLS PHARMA',gls_shop:'GLS Shop',gofo:'GOFO',temu:'TEMU'})[o.carrier]||'À déterminer')}<small>${o.partial_mode?'Ouvrir la préparation pour voir les colis':esc(transportPendingText(o))}</small>${temuTransportCostHtml(o)}${o.channel==='temu'&&!o.archived&&!o.partial_mode?'<button type="button" class="link-button" data-external-label="'+esc(o.id)+'">'+(o.source_payload?.externalLabel?.active?'Voir l’étiquette externe':'Enregistrer une étiquette externe')+'</button>':''}${!o.archived?'<button type="button" class="link-button" data-choose-carrier="'+esc(o.id)+'">Choisir un autre transporteur</button>':''}${o.carrier==='gls'&&o.gofo_zone_refusal?'<small class="gofo-zone-refusal" title="'+esc(o.gofo_zone_refusal.reason)+'">Zone GOFO refusée → GLS</small>':''}</td><td>${o.source_payload?.externalLabel?.active?'<small>Étiquette externe · '+esc(o.source_payload.externalLabel.carrier)+'</small>'+(o.source_payload.externalLabel.hasPdf?'<a class="pdf-link" target="_blank" rel="noopener" href="/api/temu/external-label/pdf?id='+encodeURIComponent(o.id)+'">▤ PDF externe ↗</a>':''):' '}${skuCopyAction(o)}${canRestartCancelledDelivery(o)?'<button class="badge" data-prepare-partial="'+esc(o.id)+'">Préparer une nouvelle livraison</button>':''}${o.partial_mode?'<button class="badge" data-prepare-partial="'+esc(o.id)+'">Préparer une nouvelle livraison</button>'+((o.partial_allocation||[]).some(l=>Number(l.remaining)>0)?'<button class="badge warn" data-prepare-partial="'+esc(o.id)+'">'+((o.partial_allocation||[]).some(l=>Number(l.allocated)>0)?'Partiellement alloué':'À allouer')+'</button><small>'+o.partial_allocation.filter(l=>Number(l.remaining)>0).map(l=>esc(l.sku)+' · '+esc(l.remaining)+' unités à allouer').join('<br>')+'</small>':'<small>Quantités entièrement allouées</small>'):o.temu_documents?.length&&!o.source_payload?.externalLabel?.active&&!o.transport_choice?o.temu_documents.map(d=>`<a class="pdf-link" target="_blank" rel="noopener" href="/api/temu/pdf?reference=${encodeURIComponent(o.reference)}&package=${encodeURIComponent(d.package)}">▤ PDF TEMU ↗</a>`).join('<br>'):o.channel==='temu'&&!o.source_payload?.externalLabel?.active&&!o.transport_choice?'<button type="button" class="badge" data-temu-order="'+esc(o.reference)+'" title="Ouvrir cette commande dans Étiquettes TEMU">'+esc(o.temu_job?.status==='api_error'?temuErrorLabel(o.temu_job?.error):o.temu_job?.status==='shipment_error'?temuErrorLabel(o.temu_job?.error):o.temu_job?.status==='document_unavailable'?'PDF TEMU non réimprimable':o.temu_job?.status==='cancellation_requested'?'Annulation demandée par le client':o.temu_job?.status==='cancelled'?'Annulée sur TEMU':o.temu_job?.status==='uncertain'?'Achat à vérifier':o.temu_job?.status==='ready'?'Achat TEMU à confirmer':o.erp_live_job?.status==='review'?'Préparation à compléter':'Étiquette TEMU à préparer')+'</button>':!o.source_payload?.externalLabel?.active&&o.document_count?Array.from({length:o.document_count},(_,i)=>`<a class="pdf-link" href="/api/carriers/documents/${encodeURIComponent(o.id)}/${i}" target="_blank" rel="noopener">▤ PDF ${o.carrier_job?.environment==='production'?'PROD':'TEST'} ${i+1}/${o.document_count+(o.extra_parcels||[]).filter(p=>p.status!=='failed').length} ↗</a>`).join('<br>'):o.resolution_active?'<button class="badge" data-exact-problem="'+esc(o.id)+'">Traitement en cours</button>':compactProblems(o).length?compactProblemButtons(o):o.resolution_pending_resume?(o.erp_live_job?.status==='complete'&&o.erp_live?.bl?.status==='ready_to_ship'&&o.erp_live?.verifiedAt&&o.erp_live?.stockCheckedAt&&o.erp_live?.labelPreparationFingerprint?'<span class="badge" title="Sélectionnez cette commande puis cliquez sur Créer les étiquettes transporteurs PROD">BL validé · étiquette à créer</span>':'<button class="badge warn" data-exact-problem="'+esc(o.id)+'">Étiquette non lancée · reprise nécessaire</button>'):badge(o.carrier_job?.status||o.label_status)}${o.channel!=='temu'&&!o.partial_mode&&!o.document_count&&!o.resolution_active&&!['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)?'<button type="button" class="refresh-circle" data-resume-order="'+esc(o.id)+'" aria-label="Actualiser et reprendre la commande" title="Actualiser et reprendre la commande"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5M20 12l-3-5"/></svg></button>':''}${o.transport_choice&&o.temu_documents?.length?'<details><summary>Ancienne étiquette TEMU · achat conservé</summary>'+o.temu_documents.map(d=>'<a target="_blank" rel="noopener" href="/api/temu/pdf?reference='+encodeURIComponent(o.reference)+'&package='+encodeURIComponent(d.package)+'">Consulter l’ancienne étiquette</a>').join('<br>')+'</details>':''}${(hasCompleteOrderDocuments(o)?(o.extra_parcels||[]).filter(p=>p.status==='ready'):(o.extra_parcels||[])).map(p=>p.status==='ready'?'<br><a class="pdf-link" target="_blank" rel="noopener" href="/api/parcels/'+encodeURIComponent(p.id)+'/document">▤ PDF '+p.parcel_index+'/'+(o.document_count+(o.extra_parcels||[]).filter(x=>x.status!=='failed').length)+'</a>':'<small>Colis '+p.parcel_index+' : '+esc(p.error||p.status)+'</small>').join('')}${!hasCompleteOrderDocuments(o)&&o.carrier_job?.stock_override?'<small class="gofo-zone-refusal">Étiquette forcée · stock insuffisant</small>':''}${inlineLabelCount2005(o)}${(o.document_count||o.channel==='temu')&&compactProblems(o).length?'<div data-correction-issue>'+compactProblemButtons(o)+'</div>':''}</td><td>${badge(o.logistics_observation?.status||'unknown')}${logisticsReadHtml(o)}<small>${o.external_shipments?.length?historicalTrackingHtml(o.external_shipments):o.channel==='temu'&&!o.transport_choice?temuTrackingHtml(o):inlineTracking2005(o)}</small></td><td data-erplain-tracking>${erplainTrackingHtml(o)}</td><td data-platform-status>${platformStatusHtml(o)}</td></tr>`).join(''):'<tr><td colspan="13">Aucune commande pour ces filtres. Importez un fichier ou utilisez une connexion API.</td></tr>';

 $('page-info').textContent=`${r.total.toLocaleString('fr-FR')} commandes · page ${page} / ${pages}`;$('prev').disabled=page<=1;$('next').disabled=page>=pages;

 $('order-rows').querySelectorAll('[data-id]').forEach(e=>e.onchange=()=>{e.checked?selected.add(e.dataset.id):selected.delete(e.dataset.id);selection();});$('select-all').checked=false;selection();

}

let mappingPage=1,mappingPages=1;

async function mappings(){const r=await api('/api/mappings?'+new URLSearchParams({search:$('mapping-search').value,page:mappingPage}));mappingPages=r.pages;$('mapping-rows').innerHTML=r.rows.map((r,i)=>`<tr>${[({amazon:'Amazon',shopify:'Shopify',temu:'TEMU',rakuten:'Rakuten'})[r.channel]||r.channel,r.source_sku,r.target_sku,r.source_qty,r.target_qty,r.notes,new Date(r.updated_at).toLocaleString('fr-FR')].map(v=>'<td>'+esc(v)+'</td>').join('')}<td><button data-edit-mapping="${i}">Modifier</button></td></tr>`).join('');$('mapping-count').textContent=r.total+' correspondances · page '+r.page+' / '+r.pages;$('mapping-rows').querySelectorAll('[data-edit-mapping]').forEach(b=>b.onclick=()=>{const m=r.rows[Number(b.dataset.editMapping)];for(const k of ['channel','source_sku','target_sku','source_qty','target_qty','notes'])$('mapping-edit').elements[k].value=m[k]??'';$('mapping-edit').scrollIntoView({behavior:'smooth',block:'start'});$('mapping-edit').elements.target_sku.focus({preventScroll:true});$('mapping-feedback').textContent='Modification de '+m.source_sku+' · '+(labels[m.channel]||m.channel);});}

async function users(){const r=await api('/api/users');$('user-rows').innerHTML=r.rows.map(u=>`<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td></tr>`).join('');}

async function audit(){const r=await api('/api/audit');$('audit-rows').innerHTML=r.rows.map(a=>`<tr><td>${esc(new Date(a.created_at).toLocaleString('fr-FR'))}</td><td>${esc(a.user_email)}</td><td>${esc(a.action)}</td><td>${esc(JSON.stringify(a.detail))}</td></tr>`).join('');}

async function show(view){currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('title').textContent=({orders:'Commandes',imports:'Imports','import-shopify':'Import Shopify',mappings:'Correspondances SKU',products:'Poids produits',connections:'Connexions',users:'Équipe',audit:'Journal des actions'})[view];try{if(view==='orders')await Promise.all([stats(),orders()]);if(view==='products')await products();if(view==='mappings')await mappings();if(view==='users')await users();if(view==='audit')await audit();if(view==='connections')await catalogStatus();}catch(e){flash(e.message,true);}}

async function enter(){user=await api('/api/me');$('login').hidden=true;$('app').hidden=false;$('identity').textContent=user.email+' · '+user.role;document.querySelector('[data-view="users"]').hidden=user.role!=='admin';document.querySelector('[data-view="audit"]').hidden=!['admin','manager'].includes(user.role);document.querySelectorAll('[data-view="imports"],[data-view="import-shopify"]').forEach(el=>el.hidden=!['admin','manager','operator'].includes(user.role));$('deliver').hidden=!['admin','manager'].includes(user.role);$('tracking').hidden=!['admin','manager','operator'].includes(user.role);await show('orders');await refreshErplainProgress();}

$('login-form').onsubmit=async e=>{e.preventDefault();try{if(setup)await api('/api/setup',{email:$('email').value,password:$('password').value,token:$('setup-token').value});await api('/api/login',{email:$('email').value,password:$('password').value});$('password').value='';$('setup-token').value='';history.replaceState(null,'','/');await enter();}catch(e){$('login-error').textContent=e.message;}};

document.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>show(el.dataset.view));

$('logout').onclick=async()=>{await api('/api/logout',{});location.reload();};

$('reload').onclick=()=>show('orders');let debounce;

for(const id of ['search','channel','status'])$(id).addEventListener(id==='search'?'input':'change',()=>{clearTimeout(debounce);debounce=setTimeout(()=>{page=1;selected.clear();show('orders');},250);});

$('mapping-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{mappingPage=1;mappings().catch(e=>flash(e.message,true));},250);};

$('prev').onclick=()=>{page--;selected.clear();show('orders');};$('next').onclick=()=>{page++;selected.clear();show('orders');};

$('select-all').onchange=()=>{$('order-rows').querySelectorAll('[data-id]').forEach(e=>{e.checked=$('select-all').checked;e.checked?selected.add(e.dataset.id):selected.delete(e.dataset.id);});selection();};

for(const id of ['tracking','deliver'])$(id).onclick=async()=>{try{const r=await api('/api/tracking',{ids:[...selected],delivered:id==='deliver'});flash(r.message);await show('orders');await refreshErplainProgress();}catch(e){flash(e.message,true);}};

let importDraft=null;

function clearImportPreview(){importDraft=null;$('import-preview').hidden=true;}

$('import-kind').onchange=clearImportPreview;$('import-file').onchange=clearImportPreview;

for(const [id,mode] of [['import-select-new','new'],['import-select-all','all'],['import-select-none','none']])$(id).onclick=()=>{for(const el of document.querySelectorAll('#import-preview-rows input'))el.checked=mode==='all'||(mode==='new'&&el.dataset.duplicate==='false');};

$('import-cancel').onclick=clearImportPreview;

$('import-form').onsubmit=async e=>{e.preventDefault();clearImportPreview();const file=$('import-file').files[0];if(!file)return;if(file.size>12*1024*1024){flash('Fichier limité à 12 Mo',true);return;}$('import-button').disabled=true;$('import-result').textContent='Analyse du fichier…';try{const content=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});const draft={kind:$('import-form').dataset.channel||$('import-kind').value,filename:file.name,content};if(draft.kind==='mapping'){const r=await api('/api/import',draft);$('import-result').textContent=r.message;flash(r.message);await stats();return;}const r=await api('/api/import/preview',draft);importDraft=r.readOnly?null:{...draft,requestId:crypto.randomUUID()};$('import-confirm').disabled=!!r.readOnly;$('import-result').textContent=(r.readOnly?'Analyse en lecture seule : import des commandes suspendu en mode préparation LIVE.\n':'')+r.errors.map(e=>'Ligne '+e.row+' : '+e.message).join('\n');$('import-summary').textContent=`${r.newCount} nouvelles commandes · ${r.duplicateCount} doublons · ${r.errors.length} erreurs de lignes`;$('import-preview-rows').innerHTML=r.orders.map(o=>`<tr><td><input type="checkbox" aria-label="Sélectionner ${esc(o.reference)}" value="${esc(o.reference)}" data-duplicate="${o.duplicate}" ${o.duplicate?'':'checked'}></td><td>${esc(o.reference)}</td><td>${esc(o.recipient)}</td><td>${o.lines}</td><td>${o.duplicate?'Doublon — nouvelle copie si coché':'Nouvelle commande'}</td></tr>`).join('');$('import-preview').hidden=false;}catch(e){$('import-result').textContent=e.message;flash(e.message,true);}finally{$('import-button').disabled=false;}};

$('import-confirm').onclick=async()=>{if(!importDraft)return;const selection=[...document.querySelectorAll('#import-preview-rows input:checked')].map(el=>el.value);if(!selection.length){flash('Sélectionnez au moins une commande.',true);return;}$('import-confirm').disabled=true;$('import-button').disabled=true;try{const duplicateSelection=[...document.querySelectorAll('#import-preview-rows input:checked[data-duplicate="true"]')].map(el=>el.value);const r=await api('/api/import',{...importDraft,selection,duplicateSelection,selectionMode:importSelectionMode,importAuthorization:importApproval});$('import-result').textContent=r.message+` ; ${r.excluded} non sélectionnées`+'\n'+r.errors.map(e=>'Ligne '+e.row+' : '+e.message).join('\n');clearImportPreview();flash(r.message);await stats();}catch(e){flash(e.message,true);}finally{$('import-confirm').disabled=false;$('import-button').disabled=false;}};



$('user-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/users',{email:$('user-email').value,password:$('user-password').value,role:$('user-role').value});$('user-form').reset();flash('Compte créé');await users();}catch(e){flash(e.message,true);}};

async function init(){const s=await api('/api/status');setup=s.setupNeeded;if(setup){$('login-title').textContent='Bienvenue dans V3.';$('login-help').textContent='Créez votre compte administrateur. Le lien d’initialisation est dans data/premiere-connexion.txt.';$('token-label').hidden=false;$('setup-token').value=new URLSearchParams(location.hash.slice(1)).get('setup')||'';$('password').autocomplete='new-password';}else{try{await enter();}catch{}}}

const startApp=()=>init().catch(e=>$('login-error').textContent=e.message);

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startApp,{once:true});else startApp();

setInterval(()=>{if(user&&!document.hidden){if(currentView==='orders'&&!window.NextechEvents?.active)refreshOrdersQuietly().catch(()=>{});if(currentView==='products'&&!window.NextechEvents?.active)products().catch(()=>{});if(currentView==='connections')catalogStatus().catch(()=>{});}},10000);

document.querySelector('.notice span').textContent='Imports réels et lecture des poids Erplain après connexion. Les étiquettes, livraisons et écritures Erplain restent simulées.';

$('status').add(new Option('Synchronisation Erplain en attente','waiting_catalog'));

const catalogPanel=document.createElement('div');catalogPanel.className='panel padded';

catalogPanel.innerHTML=`<p id="live-account-status"></p><h2>Poids produits Erplain · lecture seule</h2><p>Récupération des poids des références présentes dans vos commandes, puis recalcul automatique. Aucune écriture dans Erplain.</p><p id="catalog-status">Vérification de la connexion…</p><button id="catalog-sync" class="primary">Récupérer les poids Erplain</button><pre id="catalog-errors"></pre><details id="catalog-settings"><summary>Configurer la connexion Erplain</summary><form id="catalog-form"><div class="form-grid"><label>Adresse complète du point GraphQL<input type="url" id="erplain-url" value="https://api.erplain.app/graphql" required></label><label>Identifiant société (facultatif)<input id="erplain-company"></label><label>Clé API<input type="password" id="erplain-key" autocomplete="off" required></label></div><button class="primary">Enregistrer localement et synchroniser</button><small>La clé reste dans data/erplain-readonly.json, exclu de GitHub. Seul l’administrateur peut modifier la connexion.</small></form></details>`;

$('view-connections').prepend(catalogPanel);

async function catalogStatus(){const s=await api('/api/erplain/status');$('live-account-status').textContent=`ERPLAIN LIVE : société ${s.liveAccount?.id} · traitements activés pour les nouvelles commandes.`;$('catalog-settings').hidden=true;$('catalog-sync').disabled=false;$('catalog-status').textContent='Connexion LIVE vérifiée · réception des nouvelles commandes activée';$('catalog-errors').textContent='';const row=$('view-connections').querySelector('tbody tr');if(row)row.lastElementChild.textContent='ERPLAIN LIVE · connecté · nouvelles commandes';}



$('catalog-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{await api('/api/erplain/config',{url:$('erplain-url').value,companyId:$('erplain-company').value,apiKey:$('erplain-key').value});$('erplain-key').value='';flash('Connexion enregistrée localement. Lecture des poids lancée.');await catalogStatus();}catch(e){flash(e.message,true);}finally{button.disabled=false;}};

$('catalog-sync').onclick=async()=>{try{await api('/api/erplain/sync',{});await catalogStatus();}catch(e){flash(e.message,true);}};



let productPage=1;

async function products(){const r=await api('/api/products?'+new URLSearchParams({search:$('product-search').value,page:productPage}));$('product-rows').innerHTML=r.rows.length?r.rows.map(p=>`<tr><td>${esc(p.sku)}</td><td>${Number(p.weight_kg).toLocaleString('fr-FR',{maximumFractionDigits:6})}</td><td>${p.origin==='erplain_readonly'?'Erplain LIVE · lecture réelle':p.origin==='erplain_live_equivalent'?'Erplain LIVE · équivalent':p.origin==='simulation'?'Donnée fictive':'Origine : '+esc(p.origin||'non renseignée')}</td><td>${esc(new Date(p.updated_at).toLocaleString('fr-FR'))}</td></tr>`).join(''):'<tr><td colspan="4">Aucun poids enregistré pour cette recherche.</td></tr>';$('products-count').textContent=`${r.total} poids · page ${r.page} / ${r.pages}`;$('products-prev').disabled=r.page<=1;$('products-next').disabled=r.page>=r.pages;const s=r.sync;$('products-sync').textContent=s.nextRetryAt?`Pause Erplain ; reprise automatique le ${new Date(s.nextRetryAt).toLocaleString('fr-FR')}. Les poids enregistrés restent utilisables.`:s.running?`Récupération en cours : ${s.done} / ${s.total} références.`:s.error||`${s.cached} poids Erplain disponibles.`;}

$('products-reload').onclick=()=>products().catch(e=>flash(e.message,true));

$('product-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{productPage=1;products().catch(e=>flash(e.message,true));},250);};

$('products-prev').onclick=()=>{productPage--;products().catch(e=>flash(e.message,true));};

$('products-next').onclick=()=>{productPage++;products().catch(e=>flash(e.message,true));};

let progressLoading=false;

async function refreshErplainProgress(){

 if(!user||document.hidden||progressLoading)return;progressLoading=true;

 try{const r=await api('/api/erplain/progress'),o=r.orders;

 const bar=p=>p==null?'':`<progress max="100" value="${p}" aria-label="Avancement ${p} %"></progress>`;

 function readCard(title,s,detail){const state=s.nextRetryAt?'Pause — reprise '+new Date(s.nextRetryAt).toLocaleTimeString('fr-FR'):s.running?'En cours':s.error?'Interrompu':s.total?'Dernier passage terminé':'Aucun traitement en cours';return `<article><span>${title} · LIVE en lecture seule</span><strong>${s.percent==null?(s.running?'Total en cours de calcul':'—'):s.percent+' %'}</strong>${bar(s.percent)}<small>${esc(state)} · ${s.done} / ${s.total} références examinées<br>${esc(detail)}${s.error?'<br>'+esc(s.error):''}</small></article>`;}

 $('erplain-progress-cards').innerHTML=readCard('Poids produits',r.weights,`${r.weights.loaded||0} poids reçus sur ce passage ; ${r.weights.cached||0} en cache ; ${(r.weights.errors||[]).length} erreurs`)+readCard('Catalogue et stocks',r.stocks,r.stocks.lastRun?'Dernier passage terminé : '+new Date(r.stocks.lastRun).toLocaleString('fr-FR'):'Pas de synchronisation réussie sur cette session')+`<article><span>Commandes et BL · ERPLAIN LIVE</span><strong>${o.percent==null?'—':o.percent+' %'}</strong>${bar(o.percent)}<small>${o.complete} / ${o.total} commandes terminées et vérifiées<br>${o.processing} en cours · ${o.pending} en attente · ${o.review} à corriger · ${o.partial||0} en livraisons partielles<br>${o.bc} BC et ${o.bl} BL enregistrés${o.processedPercent==null?'':'<br>'+o.processedPercent+' % examinées, erreurs comprises'}</small></article>`;

 const phases={customer_ready:'Client prêt',bc_created:'BC créé',bl_created:'BL créé',verified:'Documents vérifiés'};

 $('erplain-progress-details').innerHTML=o.details.length?`<ul>${o.details.map(d=>`<li><strong>${esc(d.reference)}</strong> · ${d.status==='processing'?'En cours':'À corriger'} · ${esc(phases[d.phase]||d.phase||'Préparation')}${d.error?' : '+esc(d.error):''}</li>`).join('')}</ul>`:'Aucune commande en cours ni erreur à corriger.';

 $('erplain-progress-updated').textContent='Actualisé à '+new Date(r.at).toLocaleTimeString('fr-FR')+' · actualisation automatique toutes les 3 secondes · ces indicateurs ne lancent aucun appel Erplain.';

 }catch(e){$('erplain-progress-updated').textContent='Avancement indisponible : '+e.message+' — nouvelle tentative automatique.';}finally{progressLoading=false;}

}

setInterval(refreshErplainProgress,3000);









function temuTrackingHtml(o){if(o.source_payload?.externalLabel?.active)return o.source_payload.externalLabel.tracking.map(esc).join('<br>')+'<br>'+esc(o.source_payload.externalLabel.carrier)+'<br><small>Suivi via TEMU</small>'+(o.temu_job?.result?.trackingErrors?.length?'<br><small>Suivi TEMU momentanément indisponible</small>':'');if(o.temu_job?.status==='api_error')return 'Suivi TEMU non vérifié';const r=o.temu_job?.result||{},parcels=(r.packageInfoResultList||[]).map(p=>esc(p.trackingNumber||'Suivi en attente')+'<br><span class="temu-carrier-name">'+esc(p.carrier||'Transporteur non communiqué')+'</span>').join('<br>');const errors=(r.trackingErrors||[]).map(e=>String(e.error||'')),messages=[...new Set(errors.map(e=>/170070010/.test(e)?'Suivi TEMU indisponible (170070010)':/170070011/.test(e)?'Suivi non trouvé par TEMU (170070011)':'Actualisation du suivi impossible'))];return parcels+(messages.length?'<br><span title="'+esc(errors.join(' ; '))+'">'+messages.map(esc).join('<br>')+'</span>':'');}

function temuLabelDisplayOrder(o){
 if(o.source_payload?.externalLabel?.active)return o;
 if(o.channel!=='temu'||o.partial_mode||o.transport_choice)return o;
 const actualDirect=Number(o.document_count)>0||['ready','creating','awaiting_pdf','review'].includes(o.carrier_job?.status)||o.carrier_job?.hasResult||o.carrier_job?.result||(o.carrier_job?.tracking||[]).length;
 // Preserve actual existing labels; project only an unfulfilled preparation.
 if(actualDirect)return o;
 return {...o,carrier:'temu',transport_choice:null};
}
function temuTransportCostHtml(o){

 if(o.channel!=='temu')return '';

 if(o.temu_job?.status==='api_error')return '<small>Tarif non actualisé</small>';

 const parcels=o.temu_job?.result?.packageInfoResultList||[];

 if(!parcels.length){const p=o.temu_job?.plan;if(p&&Number.isFinite(p.amount)&&p.currency)return '<small class="temu-transport-cost">'+(Date.now()>p.expiresAt?'Devis expiré : ':'Devis : ')+esc(p.amount.toFixed(2)+' '+p.currency)+'</small>';return '<small class="temu-transport-cost">Tarif à calculer</small>';}

 return parcels.map((p,i)=>{

  const raw=String(p.amount??'').trim();const amount=raw&&raw!=='null'?raw.replace(/\s*€/g,' €')+(p.currency&&!/[€£$]|[A-Z]{3}/.test(raw)?' '+p.currency:''):'non communiqué';

  return '<small class="temu-transport-cost">'+(p.costEstimated?'Coût estimé':'Coût')+(parcels.length>1?' colis '+(i+1):'')+' : '+esc(amount)+'</small>';

 }).join('');

}



function temuErrorLabel(error){const s=String(error||'');if(s.includes('NOT_IN_IP_WHITE_LIST'))return 'TEMU · IP non autorisée';if(s.includes('Autorisation manquante'))return 'TEMU · Accès boutique manquant';if(s.includes('Adresse de livraison incomplète'))return 'TEMU · Adresse incomplète';if(s.includes('Articles ou quantités modifiés'))return 'TEMU · Articles à rapprocher';if(s.includes('expiré'))return 'TEMU · Accès expiré';const code=s.match(/(?:opération : |HTTP )(\d+)/)?.[1];return code?'TEMU · Erreur API '+code:'TEMU · '+s.replace(/^TEMU · /,'').slice(0,90);}



document.addEventListener('click',async e=>{const button=e.target.closest('[data-reconcile-bc]');if(!button)return;button.disabled=true;try{await api('/api/resolutions',{id:button.dataset.reconcileBc,requestId:crypto.randomUUID(),action:'reconcile-bc',type:'bc'});flash('Vérification du BC demandée dans Erplain LIVE. Aucune nouvelle création.');await orders();}catch(error){flash(error.message,true);}finally{button.disabled=false;}});



function historicalTrackingHtml(shipments){return shipments.map(s=>'<span class="historical-tracking">'+esc(String(s.carrier||'').toUpperCase())+' · '+(s.tracking||[]).map(esc).join(' · ')+'<br>BL LIVE '+esc(s.shippingLabel||'')+(s.historical?' · ancien envoi':'')+'</span>').join('<br>');}



// Label responses are attachments; avoid opening a second tab for their download.

document.addEventListener('click',event=>{

 const a=event.target.closest?.('a[href]');if(!a)return;

 const u=new URL(a.href,location.href);if(u.origin!==location.origin)return;

 if(/^\/api\/(?:carriers\/documents\/|partial\/documents\/|parcels\/[^/]+\/document$|labels\/history\/|temu\/pdf$)/.test(u.pathname)){a.removeAttribute('target');a.setAttribute('download','');}

},true);

