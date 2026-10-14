addView('temu',`<div class="panel padded"><h2>Étiquettes TEMU</h2><p>Pour les commandes importées par Excel, validez d’abord les BC/BL et le stock depuis Imports. Sélectionnez les commandes à acheter ou les étiquettes à télécharger. Les achats manuels nécessitent votre confirmation du prix. Chaque achat nécessite votre confirmation du prix, quelle que soit la marge.</p><p>Colis déclaré à TEMU : <strong>0,25 kg · 10 × 8 × 0,5 cm</strong>, indépendamment des poids Erplain. Le prix est demandé à TEMU avant chaque confirmation.</p><p id="temu-config" role="status"></p><p id="temu-summary"></p><p id="temu-sync-status" role="status" aria-live="polite">Lecture automatique des prix, PDF et du suivi auprès de TEMU…</p><progress id="temu-sync-progress" max="100" value="0" aria-label="Avancement de la synchronisation TEMU"></progress><div class="batch"><span id="temu-selection">0 sélection</span><button id="temu-clear-selection">Effacer la sélection</button><button id="temu-batch-prepare" disabled>Acheter les étiquettes sélectionnées</button><button id="temu-batch-download" disabled>Télécharger les étiquettes sélectionnées</button></div><p id="temu-purchase-selection" role="status"></p><p id="temu-message" role="status" aria-live="polite"></p><progress id="temu-progress" max="100" value="0" hidden style="width:100%"></progress><div class="batch" role="search" aria-label="Rechercher des étiquettes TEMU"><label for="temu-search" style="flex:1;min-width:200px">Rechercher<input id="temu-search" type="search" autocomplete="off" maxlength="10000" placeholder="Référence, SKU, destinataire, suivi ou BC / BL…" aria-describedby="temu-search-help" style="width:100%"></label><button id="temu-clear-search" type="button">Effacer la recherche</button><small id="temu-search-help" style="flex-basis:100%;color:#52646b">Plusieurs références PO-… : séparez-les par des espaces, virgules ou points-virgules. Vous pouvez aussi coller une colonne Excel.</small></div><div class="batch"><button id="temu-refresh">Actualiser la liste</button><button id="temu-sync">Actualiser prix, PDF et suivi</button><label>Afficher <select id="temu-filter"><option value="all">Toutes les commandes</option><option value="ready_to_buy">Prêtes à acheter</option><option value="to_buy">Toutes les étiquettes à acheter</option><option value="complete">Étiquettes disponibles</option><option value="problems">À vérifier</option></select></label><label>Suivi <select id="temu-tracking-filter"><option value="all">Tous les suivis</option><option value="not_shipped">Non expédiée</option><option value="shipped">Expédiée</option><option value="in_transit">En transit</option><option value="delivered">Livrée</option><option value="refresh">À actualiser depuis TEMU</option><option value="other">Autre statut / non renseigné</option></select></label><button id="temu-select-positive" type="button" title="Remplace la sélection par les commandes affichées dont le bénéfice calculé est supérieur à zéro">Sélectionner les marges positives</button><button id="temu-select-ready" type="button">Sélectionner les prêtes affichées</button></div><p>La marge reprend le calcul de « Commandes et livraisons ». Elle utilise le devis final de l’étiquette TTC, converti avec une TVA de 20 %. Sans devis disponible, le transport reste estimé et signalé dans le détail. Une marge complète et positive permet l’achat automatique après validation des contrôles. Une marge à compléter, nulle ou négative nécessite un achat manuel avec confirmation du prix.</p><div class="batch" aria-label="Filtres du tableau TEMU"><label>Pays <select id="temu-country-filter"><option value="">Tous</option></select></label><label>Transporteur <select id="temu-carrier-filter"><option value="">Tous</option></select></label><label>Marge estimée <select id="temu-margin-filter"><option value="">Toutes</option><option value="positive">Positive</option><option value="negative">Négative</option><option value="incomplete">À compléter</option></select></label><label>Action <select id="temu-action-filter"><option value="">Toutes</option><option value="buy">Acheter l’étiquette</option><option value="retry">Actualiser / vérifier</option><option value="cancel">Traiter l’annulation</option><option value="none">Aucune action</option></select></label><button id="temu-reset-table-filters" type="button">Effacer ces filtres</button></div><div id="temu-local-orders" class="table-wrap"></div></div>`);
let temuRows=[],temuSelected=new Set(),temuPlans=[],temuBusy=false,temuLoadVersion=0,temuPurchaseEnabled=false;
const temuStates={cancellation_requested:'Annulation demandée par le client',to_buy:'À acheter',complete:'Étiquette disponible',pending:'PDF en attente',document_unavailable:'Étiquette déjà achetée · PDF indisponible',uncertain:'Achat à vérifier',external:'Autre transporteur',cancelled:'Annulée',ready:'Achat TEMU à confirmer',not_to_ship:'Aucune expédition à préparer',unverified:'État à vérifier',shipment_error:'Étiquette refusée par TEMU',api_error:'Actualisation TEMU impossible'};
function temuSearchText(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr').replace(/\s+/g,' ').trim();}
function temuSearchGroups(query){return String(query??'').split(/[,;\r\n\t]+/).flatMap(part=>{const words=part.trim().split(/\s+/).filter(Boolean);return words.length>1&&words.every(w=>/^PO-\d+-\d+$/i.test(w))?words:[part];}).map(temuSearchText).filter(Boolean);}
function temuMatchesSearch(o,groups){if(!groups.length)return true;const text=temuSearchText([o.reference,o.recipient,o.country,o.erp_live?.bc?.label,o.erp_live?.bl?.label,...(o.sku_lines||[]).flatMap(l=>[l.source_sku,l.target_sku]),...(o.result?.packageInfoResultList||[]).flatMap(p=>[p.trackingNumber,p.packageSn,p.carrier,p.shippingCompanyName]),...(o.packages||[]),...(o.documents||[])].filter(Boolean).join(' '));return groups.some(group=>group.split(' ').every(word=>text.includes(word)));}
function temuCancellationPending(o){return o.status==='cancellation_requested'||/Annulation client en cours/.test(o.error||'');}
function temuCanRequestPrice(o){return !temuCancellationPending(o)&&(o.status==null||['to_buy','ready','unverified','api_error'].includes(o.status))&&!o.packages?.length&&!o.documents?.length;}
function temuReadyToBuy(o){return temuCanRequestPrice(o)&&['to_buy','ready'].includes(o.status)&&o.direct?.state==='verified'&&!o.error;}
function temuNotReadyReason(o){if(!['to_buy','ready'].includes(o.status))return temuStates[o.status]||'État TEMU à vérifier';if(o.packages?.length||o.documents?.length)return 'Étiquette ou colis déjà existant';if(o.direct?.state!=='verified')return 'Commande à actualiser depuis TEMU';if(o.error)return o.error;return 'Vérification TEMU nécessaire';}
function temuCostHtml(o){if(temuCancellationPending(o))return '<small>Achat suspendu · demande client à traiter dans TEMU.</small>';if(o.packages?.length||o.plan)return temuTransportCostHtml({channel:'temu',temu_job:{result:o.result,status:o.status,plan:o.plan}});if(['cancelled','not_to_ship','external'].includes(o.status))return '';return '<small>'+esc(o.error?'Prix indisponible · voir le motif':'Lecture automatique du prix TEMU…')+'</small>';}
function temuQuoteCarrierHtml(o){
 if(!temuCanRequestPrice(o)||!o.plan)return '';
 const offers=(o.plan.offers||[]).filter(p=>String(p.channelId)===String(o.plan.selected));
 const name=offers.length===1?String(offers[0].shippingCompanyName||'').trim():'';
 return '<small class="temu-quote-carrier">'+(name?'Transporteur proposé : '+esc(name):'Transporteur non communiqué par TEMU')+'</small>';
}
function temuTrackingStatus(o){if(o.status==='api_error')return 'refresh';return ['not_shipped','shipped','in_transit','delivered'].includes(o.tracking_status)?o.tracking_status:'other';}
function temuTrackingLabel(o){return ({not_shipped:'Non expédiée',shipped:'Expédiée',in_transit:'En transit',delivered:'Livrée',refresh:'À actualiser depuis TEMU'})[temuTrackingStatus(o)]||o.tracking_status||'Non renseigné';}

let temuSort={key:'reference',direction:1};
function temuCarrierNames(o){const names=(o.result?.packageInfoResultList||[]).map(p=>p.shippingCompanyName||p.carrierName||p.carrier);if(!names.some(Boolean)&&o.plan){const selected=(o.plan.offers||[]).filter(p=>String(p.channelId)===String(o.plan.selected));if(selected.length===1)names.push(selected[0].shippingCompanyName);}return [...new Set(names.filter(v=>typeof v==='string'&&v.trim()&&!['unknown','null'].includes(v.toLowerCase())).map(v=>v.trim()))].sort();}
function temuMarginRow(o){return window.V3Margins?.row(o.id);}
function temuMarginCategory(o){const r=temuMarginRow(o);return !r||r.status==='incomplete'||typeof r.profit!=='number'||!Number.isFinite(r.profit)?'incomplete':r.profit<0?'negative':'positive';}
function temuActionCategory(o){return temuCanRequestPrice(o)?'buy':temuCancellationPending(o)?'cancel':temuRetryLabel(o)?'retry':'none';}
function temuMatchesTableFilters(o){return (!$('temu-country-filter').value||String(o.country||'').toUpperCase()===$('temu-country-filter').value)&&(!$('temu-carrier-filter').value||($('temu-carrier-filter').value==='__missing__'?!temuCarrierNames(o).length:temuCarrierNames(o).includes($('temu-carrier-filter').value)))&&(!$('temu-margin-filter').value||temuMarginCategory(o)===$('temu-margin-filter').value)&&(!$('temu-action-filter').value||temuActionCategory(o)===$('temu-action-filter').value);}
function temuSortValue(o,key){return key==='country'?o.country||'':key==='carrier'?temuCarrierNames(o).join(', '):key==='status'?temuStates[o.status]||'Lecture TEMU en attente':key==='tracking'?temuTrackingLabel(o):key==='action'?temuActionCategory(o):key==='margin'?(temuMarginCategory(o)==='incomplete'?null:temuMarginRow(o).profit):o.reference;}
function temuCompareRows(a,b){const x=temuSortValue(a,temuSort.key),y=temuSortValue(b,temuSort.key);if(x==null||y==null)return x==null&&y==null?String(a.reference).localeCompare(String(b.reference)):x==null?1:-1;const delta=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'fr',{numeric:true,sensitivity:'base'});return delta*temuSort.direction||String(a.reference).localeCompare(String(b.reference),'fr',{numeric:true});}
function temuSortHeader(key,label){return '<th aria-sort="'+(temuSort.key===key?(temuSort.direction===1?'ascending':'descending'):'none')+'"><button type="button" class="link-button" data-temu-sort="'+key+'">'+label+(temuSort.key===key?(temuSort.direction===1?' ▲':' ▼'):' ↕')+'</button></th>';}
function temuFilterOptions(id,values){const el=$(id),current=el.value,missing=id==='temu-carrier-filter';el.innerHTML='<option value="">Tous</option>'+values.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join('')+(missing?'<option value="__missing__">Non renseigné</option>':'');el.value=[...el.options].some(v=>v.value===current)?current:'';}
function temuUpdateFilterOptions(){temuFilterOptions('temu-country-filter',[...new Set(temuRows.map(o=>String(o.country||'').toUpperCase()).filter(Boolean))].sort());temuFilterOptions('temu-carrier-filter',[...new Set(temuRows.flatMap(temuCarrierNames))].sort());}

function temuVisibleRows(){const f=$('temu-filter').value,groups=temuSearchGroups($('temu-search').value),tracking=$('temu-tracking-filter').value;return temuRows.filter(o=>(f==='all'||f==='ready_to_buy'&&temuReadyToBuy(o)||f==='problems'&&o.status!=='complete'&&!o.documents?.length&&(o.error||o.result?.trackingErrors?.length||['uncertain','unverified','pending','api_error','shipment_error'].includes(o.status))||f==='to_buy'&&['to_buy','ready'].includes(o.status)||o.status===f)&&(tracking==='all'||temuTrackingStatus(o)===tracking)&&temuMatchesSearch(o,groups)&&temuMatchesTableFilters(o)).sort(temuCompareRows);}
function temuRetryLabel(o){if(o.status==='complete'&&o.documents?.length)return o.result?.trackingErrors?.length?'Actualiser le suivi':'';if(o.status==='document_unavailable')return 'Vérifier le PDF';if(o.status==='pending')return 'Récupérer le PDF';if(o.status==='uncertain')return 'Vérifier l’achat';if(o.status==='shipment_error')return 'Vérifier l’étiquette';if(o.status==='api_error')return 'Actualiser depuis TEMU';return o.result?.trackingErrors?.length?'Actualiser le suivi':'';}
let temuPositiveBusy=false;
function temuUpdateSelection(){const selectedRows=temuRows.filter(o=>temuSelected.has(o.reference));const visible=new Set(temuVisibleRows().map(o=>o.reference)),hidden=selectedRows.filter(o=>!visible.has(o.reference)).length;$('temu-selection').textContent=selectedRows.length+' sélection(s)'+(hidden?' · '+hidden+' hors affichage':'');const can=temuCanPurchase();$('temu-batch-prepare').disabled=temuBusy||!can||!selectedRows.some(temuCanRequestPrice);const ready=selectedRows.filter(temuCanRequestPrice).length;$('temu-purchase-selection').textContent=selectedRows.length?ready+' commande(s) à vérifier et chiffrer parmi '+selectedRows.length+' sélection(s).'+(ready<selectedRows.length?' Les autres seront exclues de l’achat groupé : achat déjà engagé, étiquette existante ou état TEMU incompatible.':''):'Cochez les commandes souhaitées, puis cliquez sur « Acheter les étiquettes sélectionnées ».';$('temu-select-positive').disabled=temuBusy||temuPositiveBusy||!temuVisibleRows().length;$('temu-select-ready').disabled=temuBusy||!can||!temuVisibleRows().some(temuReadyToBuy);$('temu-batch-download').disabled=temuBusy||!selectedRows.some(o=>o.documents?.length);}
function temuRender(){const rows=temuVisibleRows();$('temu-clear-search').disabled=!$('temu-search').value;$('temu-summary').setAttribute('role','status');$('temu-summary').textContent=rows.length+' commande(s) affichée(s) sur '+temuRows.length+' · '+temuRows.filter(o=>['to_buy','ready'].includes(o.status)).length+' à acheter · '+temuRows.filter(o=>o.documents?.length).length+' avec PDF · '+temuRows.filter(temuReadyToBuy).length+' prêtes à acheter · '+temuRows.filter(o=>o.status==='uncertain').length+' achats à vérifier';
 $('temu-local-orders').innerHTML=`<table><thead><tr><th><input id="temu-select-all" type="checkbox" aria-label="Sélectionner les commandes affichées" ${rows.length&&rows.every(o=>temuSelected.has(o.reference))?'checked':''}></th>${temuSortHeader('reference','Commande')}${temuSortHeader('country','Pays')}${temuSortHeader('status','Étiquette / coût')}${temuSortHeader('tracking','Suivi')}${temuSortHeader('carrier','Transporteur')}${temuSortHeader('margin','Marge estimée')}${temuSortHeader('action','Action')}</tr></thead><tbody>${rows.map(o=>`<tr><td><input type="checkbox" data-temu-check="${esc(o.reference)}" aria-label="Sélectionner ${esc(o.reference)}" ${temuSelected.has(o.reference)?'checked':''}></td><td>${esc(o.reference)}<button class="link-button" data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bc">Actualiser le BC Erplain</button><button class="link-button" data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bl">Actualiser les BL Erplain</button></td><td>${esc(o.country||'Non renseigné')}</td><td>${esc(temuCancellationPending(o)?'Annulation demandée par le client':temuStates[o.status]||'Lecture TEMU en attente')}${temuCostHtml(o)}${(o.documents||[]).map(p=>`<br><a target="_blank" rel="noopener" href="/api/temu/pdf?reference=${encodeURIComponent(o.reference)}&package=${encodeURIComponent(p)}">PDF ${esc(p)}</a>`).join('')}<small>${esc(o.error||'')}</small></td><td>${esc(temuTrackingLabel(o))}<small>${temuTrackingHtml({temu_job:{result:o.result,status:o.status,plan:o.plan}})}</small></td><td>${esc(temuCarrierNames(o).join(', ')||'Non renseigné')}</td><td data-temu-margin="${esc(o.id)}">Chargement de la marge…</td><td>${temuCanRequestPrice(o)?`<button data-temu-price="${esc(o.reference)}" ${temuBusy||!temuCanPurchase()?'disabled':''}>Acheter l’étiquette</button>`:''}${temuCancellationPending(o)?`<a class="button" href="https://seller-eu.temu.com/" target="_blank" rel="noopener">Traiter l’annulation dans TEMU ↗</a><button data-temu-retry="${esc(o.reference)}" ${temuBusy?'disabled':''}>Vérifier l’annulation TEMU</button><small>L’annulation Erplain reste à vérifier après confirmation TEMU.</small>`:''}${(!temuCancellationPending(o)&&temuRetryLabel(o))?`<button data-temu-retry="${esc(o.reference)}" ${temuBusy?'disabled':''}>${esc(temuRetryLabel(o))}</button>`:''}</td></tr>`).join('')||'<tr><td colspan="8">Aucune commande ne correspond à cette recherche et aux filtres.</td></tr>'}</tbody></table>`;
 $('temu-local-orders').querySelectorAll('[data-temu-sort]').forEach(b=>b.onclick=()=>{const key=b.dataset.temuSort;temuSort={key,direction:temuSort.key===key?-temuSort.direction:1};temuRender();});
 $('temu-select-all').indeterminate=rows.some(o=>temuSelected.has(o.reference))&&!rows.every(o=>temuSelected.has(o.reference));$('temu-select-all').onchange=e=>{for(const o of rows){if(e.target.checked)temuSelected.add(o.reference);else temuSelected.delete(o.reference);}temuRender();};$('temu-local-orders').querySelectorAll('[data-temu-check]').forEach(b=>b.onchange=()=>{if(b.checked)temuSelected.add(b.dataset.temuCheck);else temuSelected.delete(b.dataset.temuCheck);temuUpdateSelection();});$('temu-local-orders').querySelectorAll('[data-temu-price]').forEach(b=>b.onclick=()=>temuStartPurchase(temuRows.filter(o=>o.reference===b.dataset.temuPrice)));$('temu-local-orders').querySelectorAll('[data-temu-retry]').forEach(b=>b.onclick=()=>temuTask(async update=>{update(0,1,'Actualisation TEMU');await api('/api/temu/recover',{reference:b.dataset.temuRetry});await temuLoad();update(1,1,'Commande actualisée');}));temuUpdateSelection();window.V3Margins?.paintTemu();
}
async function temuLoad(){const version=++temuLoadVersion;$('temu-message').textContent='Chargement des commandes…';try{const r=await api('/api/temu/local');if(version!==temuLoadVersion)return;if(!Array.isArray(r.rows))throw Error('Réponse de la liste TEMU invalide');temuRows=r.rows;temuUpdateFilterOptions();temuSelected=new Set([...temuSelected].filter(ref=>temuRows.some(o=>o.reference===ref)));temuRender();window.V3Margins?.refresh();$('temu-message').textContent='Liste actualisée.';}catch(e){if(version===temuLoadVersion){$('temu-message').textContent='Chargement impossible : '+e.message+'. Utilisez « Actualiser la liste » pour réessayer.';if(!temuRows.length)$('temu-local-orders').textContent='Les commandes ne peuvent pas être affichées pour le moment.';}}
}
async function temuTask(fn){
 if(temuBusy)return;temuBusy=true;const start=Date.now();let done=0,total=1,label='Traitement en cours';
 $('temu-progress').hidden=false;$('temu-progress').value=0;$('temu-refresh').disabled=true;$('temu-sync').disabled=true;temuRender();temuUpdatePurchaseControls();
 const renderProgress=()=>{const percent=total?Math.floor(done/total*100):0,message=label+' · '+percent+' % · '+Math.floor((Date.now()-start)/1000)+' s';$('temu-message').textContent=message;if(temuPurchaseDialog.open){$('temu-purchase-progress').value=percent;$('temu-purchase-message').textContent=message;}};
 const update=(d,t,l)=>{done=d;total=t;label=l;$('temu-progress').value=total?Math.floor(done/total*100):0;renderProgress();};
 const timer=setInterval(renderProgress,1000);
 try{await fn(update);}catch(e){const message='Traitement interrompu : '+e.message;$('temu-message').textContent=message;if(temuPurchaseDialog.open)$('temu-purchase-message').textContent=message;}
 finally{clearInterval(timer);temuBusy=false;$('temu-refresh').disabled=false;$('temu-sync').disabled=false;temuRender();temuUpdatePurchaseControls();}
}
$('temu-search').oninput=temuRender;
$('temu-search').onpaste=e=>{const text=e.clipboardData?.getData('text');if(text&&/[\r\n\t]/.test(text)){e.preventDefault();const input=$('temu-search');input.setRangeText(text.replace(/[\r\n\t]+/g,'; '),input.selectionStart,input.selectionEnd,'end');temuRender();}};
$('temu-clear-search').onclick=()=>{$('temu-search').value='';temuRender();$('temu-search').focus();};
$('temu-select-ready').onclick=()=>{if(temuBusy||!temuCanPurchase())return;for(const o of temuVisibleRows().filter(temuReadyToBuy))temuSelected.add(o.reference);temuRender();};
$('temu-clear-selection').onclick=()=>{temuSelected.clear();temuRender();};$('temu-filter').onchange=temuRender;$('temu-tracking-filter').onchange=temuRender;$('temu-refresh').onclick=temuLoad;
let temuSyncTimer=null,temuSyncSignature='',temuSyncStarted=Date.now();
async function temuWatchSync(){
 clearTimeout(temuSyncTimer);if(currentView!=='temu'||!user)return;$('title').textContent='Étiquettes TEMU';
 try{const state=await api('/api/temu/sync-status'),signature=JSON.stringify([state.checked,state.remaining,state.errors,state.lastCheckedAt]);
  const percent=state.percent||0;$('temu-sync-progress').value=percent;
  $('temu-sync-status').textContent=!state.workerAvailable?'Synchronisation en attente : traitement serveur indisponible.':state.total===0?'Initialisation de la lecture TEMU…':state.remaining?'Lecture directe TEMU · '+(state.total-state.remaining)+' / '+state.total+' · '+percent+' % · '+Math.floor((Date.now()-temuSyncStarted)/1000)+' s · '+state.errors+' erreur(s) signalée(s) dans les lignes.':'Lecture TEMU terminée · '+state.total+' commande(s) · '+state.errors+' erreur(s) signalée(s) dans les lignes. Actualisation périodique active.';
  if(signature!==temuSyncSignature&&!temuBusy&&!temuPurchaseDialog.open){await temuLoad();temuSyncSignature=signature;}
 }catch(e){$('temu-sync-status').textContent='État de synchronisation indisponible : '+e.message;}
 if(currentView==='temu')temuSyncTimer=setTimeout(temuWatchSync,5000);
}
$('temu-sync').onclick=async()=>{if(temuBusy)return;$('temu-sync').disabled=true;try{await api('/api/temu/sync',{});temuSyncStarted=Date.now();temuSyncSignature='';await temuWatchSync();}catch(e){$('temu-sync-status').textContent='Actualisation impossible : '+e.message;}finally{$('temu-sync').disabled=false;}};
$('temu-batch-download').onclick=()=>{const refs=temuRows.filter(o=>temuSelected.has(o.reference)&&o.documents?.length).map(o=>o.reference);if(refs.length)downloadMerged([],refs).catch(e=>{$('temu-message').textContent=e.message;});};
// Opening a quote never purchases a label. Only the confirmed button calls /buy.
const temuPurchaseDialog=document.createElement('dialog');
temuPurchaseDialog.id='temu-purchase-dialog';
temuPurchaseDialog.setAttribute('aria-labelledby','temu-purchase-title');
temuPurchaseDialog.innerHTML='<header><h2 id="temu-purchase-title">Achat d’étiquettes TEMU</h2><button id="temu-purchase-close" type="button">Fermer</button></header><p id="temu-purchase-message" role="status" aria-live="polite"></p><progress id="temu-purchase-progress" max="100" value="0" aria-label="Avancement de l’achat TEMU"></progress><div id="temu-preview"></div>';
document.body.append(temuPurchaseDialog);
let temuOfferTimer=null,temuPurchaseRows=[],temuPurchaseExcluded=[];
function temuCanPurchase(){return ['admin','manager','operator'].includes(user?.role);}
function temuOffersCurrent(){return temuPlans.length>0&&temuPlans.every(p=>Number(p.expiresAt)>Date.now());}
function temuUpdatePurchaseControls(){
 $('temu-purchase-close').disabled=temuBusy;
 const confirm=$('temu-batch-confirm'),buy=$('temu-batch-buy'),refresh=$('temu-refresh-offers'),expiry=$('temu-offer-expiry');
 const allowed=temuCanPurchase()&&temuPurchaseEnabled&&temuOffersCurrent();
 if(confirm){confirm.disabled=temuBusy||!allowed;if(!allowed)confirm.checked=false;}
 if(buy)buy.disabled=temuBusy||!allowed||!confirm?.checked;
 if(refresh)refresh.disabled=temuBusy||!temuCanPurchase();
 if(expiry&&temuPlans.length){const seconds=Math.max(0,Math.floor((Math.min(...temuPlans.map(p=>Number(p.expiresAt)))-Date.now())/1000));expiry.textContent=seconds?'Prix valables encore '+Math.floor(seconds/60)+' min '+seconds%60+' s.':'Prix expirés. Actualisez les prix avant de confirmer.';}
}
function temuClosePurchase(){if(temuBusy)return;temuPurchaseDialog.close();}
$('temu-purchase-close').onclick=temuClosePurchase;
temuPurchaseDialog.addEventListener('cancel',e=>{if(temuBusy)e.preventDefault();});
temuPurchaseDialog.addEventListener('close',()=>{clearInterval(temuOfferTimer);temuOfferTimer=null;temuPlans=[];$('temu-preview').textContent='';});
function temuValidateOffer(p,reference){
 if(!p?.id||p.reference!==reference||p.amount===null||p.amount===undefined||String(p.amount).trim()===''||!Number.isFinite(Number(p.amount))||Number(p.amount)<0||!/^[A-Z]{3}$/.test(p.currency||'')||!(Number(p.expiresAt)>Date.now()))throw Error('Offre incomplète ou expirée : actualisez le tarif.');
 return p;
}
// These endpoints only read TEMU / store a local quote. /buy is deliberately excluded.
async function temuReadForPurchase(path,data,update,done,total){
 if(!['/api/temu/status','/api/temu/local','/api/temu/recover','/api/temu/prepare'].includes(path))throw Error('Reprise automatique interdite pour cette action');
 for(let attempt=0;;attempt++){
  try{return await api(path,data);}
  catch(e){
   if(!e.retryable||attempt>=3)throw e;
   update(done,total,'Connexion V3 interrompue · reprise des prix '+(attempt+1)+'/3 · aucun achat envoyé');
   await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
  }
 }
}
function temuStopsPriceBatch(e){return e.retryable||e.status===401||e.status===403||e.status>=500;}
function temuStartPurchase(rows,excluded=[]){
 if(temuBusy)return;
 if(!temuCanPurchase()){$('temu-message').textContent='Votre rôle ne permet pas l’achat d’étiquettes.';return;}
 clearInterval(temuOfferTimer);temuOfferTimer=null;temuPlans=[];temuPurchaseRows=rows.slice();temuPurchaseExcluded=excluded.slice();
 $('temu-preview').textContent='Lecture des prix auprès de TEMU. Aucun achat à cette étape.';
 $('temu-purchase-message').textContent='Vérification de l’accès TEMU…';$('temu-purchase-progress').value=0;
 if(!temuPurchaseDialog.open)temuPurchaseDialog.showModal();
 return temuTask(async update=>{
  temuPurchaseEnabled=false;
  const errors=[];let interrupted=[],checked=0;
  try{
   const status=await temuReadForPurchase('/api/temu/status',undefined,update,0,rows.length);temuPurchaseEnabled=status.purchaseEnabled===true;
  }catch(e){
   errors.push({reference:'',error:e.message});interrupted=rows;
   temuRenderOffers(errors,excluded,interrupted);update(0,rows.length,'Lecture interrompue · aucun achat effectué');return;
  }
  for(const [i,o] of rows.entries()){
   update(i,rows.length,'Vérification des prix TEMU');
   try{
    if(!temuCanRequestPrice(o))throw Error(temuNotReadyReason(o));
    if(!temuReadyToBuy(o)){
     update(i,rows.length,'Vérification de la commande auprès de TEMU');
     await temuReadForPurchase('/api/temu/recover',{reference:o.reference},update,i,rows.length);
     const fresh=await temuReadForPurchase('/api/temu/local',undefined,update,i,rows.length);
     const current=fresh.rows?.find(row=>row.reference===o.reference);
     if(!current||!temuReadyToBuy(current))throw Error(current?temuNotReadyReason(current):'Commande absente après actualisation TEMU');
    }
    update(i,rows.length,'Lecture du prix TEMU');
    temuPlans.push(temuValidateOffer(await temuReadForPurchase('/api/temu/prepare',{reference:o.reference},update,i,rows.length),o.reference));
   }
   catch(e){errors.push({reference:o.reference,error:e.message});if(temuStopsPriceBatch(e)){interrupted=rows.slice(i);break;}}
   checked=i+1;
  }
  if(!interrupted.length)await temuLoad();
  temuRenderOffers(errors,excluded,interrupted);
  update(checked,rows.length,interrupted.length?'Lecture interrompue · sélection conservée · aucun achat effectué':temuPlans.length?'Prix disponibles · confirmation nécessaire':'Aucun prix disponible · aucun achat effectué');
 });
}
$('temu-batch-prepare').onclick=()=>{
 const selected=temuRows.filter(o=>temuSelected.has(o.reference));
 const eligible=selected.filter(temuCanRequestPrice);
 const excluded=selected.filter(o=>!eligible.includes(o)).map(o=>({reference:o.reference,error:temuNotReadyReason(o)}));
 if(eligible.length)return temuStartPurchase(eligible,excluded);
};
function temuRenderOffers(errors,excluded=[],interrupted=[]){
 const totals={};for(const p of temuPlans)totals[p.currency]=(totals[p.currency]||0)+Math.round(Number(p.amount)*100);

 $('temu-preview').innerHTML='<p>Vérifiez le transporteur et le prix de chaque étiquette, puis confirmez l’achat.</p><p>La marge utilise le devis final de l’étiquette, avec une TVA de 20 %. Elle ne bloque pas l’achat.</p>'+
  errors.map(e=>'<p class="error">'+(e.reference?esc(e.reference)+' : ':'')+esc(e.error)+'</p>').join('')+
  (interrupted.length?'<details open><summary>'+interrupted.length+' commande(s) restant à chiffrer · aucun achat effectué</summary>'+interrupted.map(o=>'<p>'+esc(o.reference)+'</p>').join('')+'</details>':'')+
  (excluded.length?'<details><summary>'+excluded.length+' commande(s) exclue(s) de cet achat</summary>'+excluded.map(e=>'<p>'+esc(e.reference)+' · '+esc(e.error)+'</p>').join('')+'</details>':'')+

  (temuPlans.length?'<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Transporteur</th><th>Prix</th><th>Marge estimée</th></tr></thead><tbody>'+temuPlans.map(p=>'<tr><td>'+esc(p.reference)+'</td><td>'+esc(p.offers?.find(o=>o.channelId===p.selected)?.shippingCompanyName||'Transporteur de l’offre')+'</td><td>'+esc(Number(p.amount).toFixed(2)+' '+p.currency)+'</td><td data-temu-margin="'+esc(temuPurchaseRows.find(o=>o.reference===p.reference)?.id||'')+'">Chargement de la marge…</td></tr>').join('')+'</tbody></table></div><p><strong>Total estimé : '+Object.entries(totals).map(([c,n])=>esc((n/100).toFixed(2)+' '+c)).join(' + ')+'</strong></p><p id="temu-offer-expiry" role="status"></p><p><input id="temu-batch-confirm" type="checkbox" aria-label="Je confirme les prix affichés"> Je confirme l’achat réel de '+temuPlans.length+' étiquette(s) aux prix affichés.</p><button id="temu-batch-buy" type="button" class="primary" disabled>Confirmer et acheter '+temuPlans.length+' étiquette(s)</button>':'<p>Aucune offre achetable. Aucun achat effectué.</p>')+
  (temuPurchaseEnabled?'':'<p>Accès TEMU en lecture seule : tarifs consultables, achat indisponible.</p>')+
  '<p><button id="temu-refresh-offers" type="button">'+(interrupted.length?'Reprendre la lecture des prix':'Actualiser les prix')+'</button></p>';
 window.V3Margins?.paintTemu();
 $('temu-refresh-offers').onclick=()=>temuStartPurchase(temuPurchaseRows,temuPurchaseExcluded);
 if(temuPlans.length){
  $('temu-batch-confirm').onchange=temuUpdatePurchaseControls;
  $('temu-batch-buy').onclick=temuBuyConfirmed;
  clearInterval(temuOfferTimer);temuOfferTimer=setInterval(temuUpdatePurchaseControls,1000);
 }
 temuUpdatePurchaseControls();
}
function temuBuyConfirmed(){
 if(temuBusy||!temuCanPurchase()||!temuPurchaseEnabled||!temuOffersCurrent()||!$('temu-batch-confirm')?.checked){temuUpdatePurchaseControls();return;}
 const plans=temuPlans.slice();$('temu-batch-confirm').checked=false;
 return temuTask(async update=>{
  const results=[];let attempted=0;
  for(const [i,p] of plans.entries()){
   update(i,plans.length,'Achat confirmé');attempted++;
   try{await api('/api/temu/buy',{reference:p.reference,planId:p.id,amount:p.amount,confirmPurchase:true});results.push(p.reference+' : demande enregistrée, vérifier le PDF.');}
   catch(e){results.push(p.reference+' : '+e.message+' — vérifier avant toute nouvelle tentative.');break;}
   update(i+1,plans.length,'Achat confirmé');
  }
  if(attempted<plans.length)results.push((plans.length-attempted)+' étiquette(s) non demandée(s) après l’arrêt du traitement.');
  clearInterval(temuOfferTimer);temuOfferTimer=null;temuPlans=[];await temuLoad();
  $('temu-preview').innerHTML=results.map(s=>'<p>'+esc(s)+'</p>').join('');
  update(attempted,plans.length,'Traitement terminé · consultez le résultat');
 });
}

// Navigate to the requested order without preparing or buying a label.
async function temuOpenOrder(reference){
 const ref=String(reference||'').trim();if(!ref)return;
 $('temu-search').value=ref;
 $('temu-filter').value='all';$('temu-tracking-filter').value='all';for(const id of ['temu-country-filter','temu-carrier-filter','temu-margin-filter','temu-action-filter'])$(id).value='';
 temuSelected.clear();temuRender();
 await show('temu');
 if(currentView!=='temu'||$('temu-search').value!==ref)return;
 $('temu-local-orders').scrollIntoView({behavior:'smooth',block:'start'});
 const action=[...$('temu-local-orders').querySelectorAll('[data-temu-price]')].find(button=>button.dataset.temuPrice===ref&&!button.disabled);
 (action||$('temu-search')).focus({preventScroll:true});
}
$('order-rows').addEventListener('click',async event=>{
 const purchase=event.target.closest('[data-temu-purchase]');
 if(purchase){
  if(temuBusy||purchase.disabled)return;
  purchase.disabled=true;
  try{
   const result=await api('/api/temu/local'),row=result.rows?.find(o=>o.reference===purchase.dataset.temuPurchase);
   if(!row)throw Error('Commande absente de la liste TEMU');
   await temuStartPurchase([row]);
  }catch(error){flash(error.message,true);}finally{purchase.disabled=false;}
  return;
 }

 const button=event.target.closest('[data-temu-order]');
 if(button)temuOpenOrder(button.dataset.temuOrder).catch(error=>{ $('temu-message').textContent='Ouverture impossible : '+error.message; });
});

const temuNav=document.createElement('button');temuNav.dataset.view='temu';temuNav.textContent='Étiquettes TEMU';document.querySelector('nav').append(temuNav);temuNav.onclick=()=>show('temu');
const beforeTemuShow=show;show=async function(view){if(view!=='temu')return beforeTemuShow(view);currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-temu');document.querySelectorAll('[data-view]').forEach(el=>{const active=el.dataset.view==='temu';el.classList.toggle('active',active);if(active)el.closest('details')?.setAttribute('open','');});$('title').textContent='Étiquettes TEMU';$('temu-config').textContent='Source : API TEMU directe. Les données historiques non vérifiées ne confirment pas l’état actuel de la commande.';temuPurchaseEnabled=false;await temuLoad();temuSyncStarted=Date.now();temuWatchSync();api('/api/temu/status').then(s=>{temuPurchaseEnabled=s.purchaseEnabled===true;temuUpdatePurchaseControls();$('temu-config').textContent=s.configured?(s.purchaseEnabled?'Accès TEMU actif. Achat automatique si la marge est positive et les contrôles validés ; sinon, achat manuel.':'Accès TEMU en lecture seule : commandes, PDF, suivi et tarifs. Achat indisponible sur cet accès.'):'Accès d’achat TEMU non configurés. Les étiquettes existantes restent consultables.';}).catch(e=>{$('temu-config').textContent='Accès d’achat non vérifié : '+e.message;});};

function temuPositiveReferences(rows,margins){const positive=new Set(margins.filter(r=>r.status==='positive'&&typeof r.profit==='number'&&Number.isFinite(r.profit)&&r.profit>0).map(r=>r.id));return rows.filter(o=>positive.has(o.id)).map(o=>o.reference);}
$('temu-select-positive').onclick=async()=>{if(temuBusy||temuPositiveBusy)return;temuPositiveBusy=true;temuUpdateSelection();$('temu-message').textContent='Vérification des marges positives…';try{const result=await api('/api/margins');if(!Array.isArray(result?.rows))throw Error('Réponse du calcul des marges invalide');if(temuBusy)throw Error('Une opération TEMU est en cours. Réessayez après sa fin.');const refs=temuPositiveReferences(temuVisibleRows(),result.rows);temuSelected.clear();for(const ref of refs)temuSelected.add(ref);temuRender();$('temu-message').textContent=refs.length+' commande(s) à marge positive sélectionnée(s) parmi les commandes affichées. La sélection précédente a été remplacée. Aucun achat effectué.';}catch(e){$('temu-message').textContent='Sélection des marges positives impossible : '+e.message+'. Votre sélection a été conservée.';}finally{temuPositiveBusy=false;temuUpdateSelection();}};

for(const id of ['temu-country-filter','temu-carrier-filter','temu-margin-filter','temu-action-filter'])$(id).onchange=temuRender;
$('temu-reset-table-filters').onclick=()=>{for(const id of ['temu-country-filter','temu-carrier-filter','temu-margin-filter','temu-action-filter'])$(id).value='';temuRender();};
window.addEventListener('v3-margins-updated',()=>{if(currentView==='temu')temuRender();});
