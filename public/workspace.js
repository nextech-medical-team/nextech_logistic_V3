Object.assign(labels,{production_ready:'Étiquette transporteur PROD'});
Object.assign(labels,{sandbox_ready:'Étiquette transporteur TEST',ready:'PDF disponible',creating:'Création en cours',awaiting_pdf:'PDF en attente',failed:'Erreur transporteur',review:'À vérifier chez le transporteur'});
const originalShow=show;
show=async function(view){
 if(view==='shipments'||view==='technical'||view==='coverage'){
  currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('title').textContent={shipments:'Expéditions',technical:'Espace technique',coverage:'Fonctions de l’ancienne plateforme'}[view];
  try{if(view==='shipments')await shipments();if(view==='technical')await technical();}catch(e){flash(e,true);}return;
 }await originalShow(view);
};
function addView(id,html){const el=document.createElement('section');el.id='view-'+id;el.className='view';el.hidden=true;el.innerHTML=html;document.querySelector('main').append(el);}
addView('import-shopify','');
const sharedImportPanel=$('import-form').closest('.panel');
const showBeforeImportScreens=show;
show=async function(view){
 if(view==='imports'||view==='import-shopify'){
  const shopify=view==='import-shopify';
  if(currentView!==view){clearImportPreview();$('import-file').value='';$('import-result').textContent='';}
  $('view-'+view).prepend(sharedImportPanel);
  $('import-kind').closest('label').hidden=shopify;
  $('import-file').accept=shopify?'.xlsx,.csv':'.txt,.tsv,.csv,.xlsx';
  sharedImportPanel.querySelector('h2').textContent=shopify?'Importer des commandes Shopify':'Importer un fichier';
  $('shopify-import-help').hidden=!shopify;
  $('import-form').dataset.channel=shopify?'shopify':'';
  if(shopify){
   currentView=view;
   document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+view);
   document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
   $('title').textContent='Import Shopify';
   return;
  }
 }
 await showBeforeImportScreens(view);
};
const nav=document.querySelector('nav');
nav.innerHTML=`<small class="nav-label">COMMANDES</small><button data-view="orders">Toutes les commandes</button><a href="/receptions.html" class="receipt-navigation">Réceptions ERPLAIN</a>${[['amazon','Amazon'],['shopify','Shopify'],['temu','TEMU'],['tender','Appels d’offres']].map(([c,t])=>`<button data-channel="${c}">${t}</button>`).join('')}<small class="nav-label">EXPÉDITIONS</small>${['gls','gofo','temu'].map(c=>`<button data-carrier="${c}">${c.toUpperCase()}</button>`).join('')}<small class="nav-label">PARAMÈTRES</small><button data-view="imports">Imports de fichiers</button><button data-view="import-shopify">Import Shopify · Excel</button><button data-view="mappings">Mapping SKU</button><button data-view="products">Poids produits</button><button data-view="connections">Transporteurs et connexions</button><button data-view="coverage">Sections et état d’avancement</button><button data-view="technical">Espace technique</button><button data-view="users">Équipe</button><button data-view="audit">Journal des actions</button>`;
nav.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>{if(el.dataset.view==='orders')$('channel').value='';show(el.dataset.view);});
nav.querySelectorAll('[data-channel]').forEach(el=>el.onclick=()=>{$('channel').value=el.dataset.channel;page=1;selected.clear();show('orders');});
nav.querySelectorAll('[data-carrier]').forEach(el=>el.onclick=()=>{$('shipment-carrier').value=el.dataset.carrier;show('shipments');});
document.querySelector('.notice').innerHTML='V3 · ERPLAIN LIVE <span>Nouvelles commandes TEMU et Shopify depuis le 6 octobre à 10 h 45 min 34 s. Traitements activés. Achats TEMU automatiques après contrôles, si marge nette positive et transporteur hors Cainiao ; sinon confirmation. Reprise historique suspendue.</span>';
document.querySelector('#login small').textContent='Erplain LIVE connecté';
const batch=document.querySelector('#view-orders .batch');const create=document.createElement('button');create.id='sandbox-labels';create.textContent='Créer les étiquettes transporteurs PROD';batch.append(create);
const exportButton=document.createElement('button');exportButton.textContent='Exporter la sélection';batch.append(exportButton);
create.onclick=async()=>{try{const r=await api('/api/carriers/labels',{ids:[...selected]});flash(r.message);window.getSelection()?.removeAllRanges();preparedOrderResponse=null;await orders();}catch(e){flash(e,true);}};
function downloadCsv(name,rows){
 const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
 const content='\ufeff'+rows.map(r=>r.map(cell).join(';')).join('\r\n'),a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
exportButton.disabled=true;const beforeExportSelection=selection;selection=()=>{beforeExportSelection();exportButton.disabled=!selected.size;};
exportButton.onclick=async()=>{if(!selected.size)return;exportButton.disabled=true;try{const r=await api('/api/orders/export',{ids:[...selected]});const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date()).replace(/[^0-9]/g,'');downloadCsv('Commandes_'+stamp+'_'+selected.size+'-selectionnees.csv',[['Commande','Gestionnaire','Date','SKU gestionnaire','SKU Erplain','Nom produit','Quantité gestionnaire','Quantité Erplain','Destinataire','Adresse','Ville','Code postal','Pays','Poids kg','Colis','Transporteur','Étiquette','Erplain','Livraison','Message'],...r.rows.map(o=>[o.reference,({amazon:'Amazon',shopify:'Shopify',temu:'TEMU',tender:'Appels d’offres',samples:'Échantillons'})[o.channel]||o.channel,o.source_date,o.source_sku,o.target_sku||(['tender','samples'].includes(o.channel)?o.source_sku:''),o.line_source?.productname||o.line_source?.itemname||o.line_source?.title||o.line_source?.name||o.line_source?.designation||o.line_source?.label||'Non renseigné',o.quantity,o.target_quantity??(['tender','samples'].includes(o.channel)?o.quantity:''),o.recipient,o.address?.street,o.address?.city,o.address?.postal,o.address?.country,o.weight_kg,o.parcel_count,o.carrier,o.label_status,o.erp_status,o.tracking_status,o.issue])]);}catch(e){flash(e,true);}finally{selection();}};
addView('shipments',`<div class="panel padded"><h2>Livraisons et étiquettes transporteurs</h2><p>Les PDF indiquent TEST ou PROD selon le circuit utilisé. Une étiquette générée ne signifie pas que le colis a été expédié. Toutes les demandes sont accessibles par pagination.</p><div class="filters"><select id="shipment-carrier"><option value="">Tous les transporteurs</option><option value="gls">GLS</option><option value="gofo">GOFO</option><option value="temu">TEMU</option></select><input id="shipment-search" placeholder="Commande, destinataire ou suivi"><button id="shipment-refresh">Actualiser</button></div><p id="shipment-count"></p><div class="table-wrap"><table><thead><tr><th>Commande / canal</th><th>Date</th><th>Destinataire</th><th>Ville / CP</th><th>Transporteur</th><th>État / message</th><th>PDF</th><th>Suivi</th><th>Colis / poids</th><th>Erplain / livraison</th></tr></thead><tbody id="shipment-rows"></tbody></table></div></div>`);
let shipmentPage=1,shipmentPages=1,shipmentSort='date',shipmentDirection='desc';
async function shipments(){const params=new URLSearchParams({page:shipmentPage,search:$('shipment-search').value,sort:shipmentSort,direction:shipmentDirection});for(const o of $('shipment-carrier').selectedOptions)if(o.value)params.append('carrier',o.value);for(const o of $('shipment-status').selectedOptions)params.append('status',o.value);const r=await api('/api/carriers/status?'+params),rows=r.rows;shipmentPages=r.pages;$('shipment-count').textContent=`${r.total} demandes · page ${r.page} / ${r.pages} · GLS et GOFO traités indépendamment`;
 $('shipment-rows').innerHTML=rows.map(o=>`<tr><td>${esc(o.reference)}<small>${esc(labels[o.channel]||o.channel)}</small></td><td>${esc(new Date(o.updated_at).toLocaleString('fr-FR'))}</td><td>${esc(o.recipient)}</td><td>${esc(o.address.city)}<small>${esc(o.address.postal)}</small></td><td>${esc(o.carrier.toUpperCase())}</td><td>${badge(o.status)}<small>${errorDetailsHtml(o.error||'')}</small></td><td>${Array.from({length:o.documents},(_,i)=>`<a target="_blank" rel="noopener" href="/api/carriers/documents/${encodeURIComponent(o.order_id)}/${i}">PDF ${i+1} ↗</a>`).join('<br>')}</td><td>${o.tracking.map(esc).join('<br>')||'—'}</td><td>${esc(o.parcel_count)} colis<small>${esc(o.weight_kg)} kg</small></td><td>${badge(o.erp_status)}<small>${esc(labels[o.tracking_status]||o.tracking_status)}</small></td></tr>`).join('')||'<tr><td colspan="10">Aucune demande pour ce filtre. Sélectionnez des commandes prêtes puis lancez les étiquettes de test.</td></tr>';
}
$('shipment-refresh').onclick=()=>shipments().catch(e=>flash(e,true));$('shipment-carrier').onchange=$('shipment-refresh').onclick;$('shipment-search').oninput=$('shipment-refresh').onclick;
addView('technical','<div class="panel padded"><h2>Files de traitement</h2><p>Les appels transporteurs sont exécutés hors transaction de base de données. Un travail GLS et un travail GOFO peuvent avancer simultanément. Une création au résultat incertain reste à vérifier, sans renvoi automatique.</p><button id="technical-refresh">Actualiser</button><div id="technical-status"></div></div>');
async function technical(){const r=await api('/api/technical');$('technical-status').innerHTML=[['Traitements locaux',r.jobs],['Transporteurs GLS / GOFO',r.carriers]].map(([title,rows])=>`<h3>${title}</h3><table><thead><tr><th>File</th><th>État</th><th>Nombre</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.kind||x.carrier)}</td><td>${esc(x.status)}</td><td>${x.count}</td></tr>`).join('')}</tbody></table>`).join('');}
$('technical-refresh').onclick=()=>technical().catch(e=>flash(e,true));
const coverage=[
 ['Commandes multi-marketplaces / Amazon','Import TXT et Excel, sélection, export CSV, détail des lignes et données source disponibles.'],
 ['Commandes Shopify / TEMU','Shopify : lecture API et import local disponibles. TEMU : accès configurés ; la collecte dépend notamment de l’autorisation de l’IP serveur. Aucun achat automatique.'],
 ['Expéditions GLS','Création TEST et PROD, compte MONO, PDF et numéros de suivi. Suivi automatique, POD et changement de transporteur restant à intégrer.'],
 ['Expéditions GOFO','Création TEST et PROD et récupération PDF intégrées ; les refus réels restent visibles par commande. Aucun PDF fictif présenté comme une étiquette GOFO.'],
 ['Mapping SKU','Import Excel, recherche, ajout/modification des ratios et notes, suppression. Export Excel complet et pagination disponibles.'],
 ['Poids produits','Cache des poids et onglet stocks réels Erplain (lecture seule), recherche et date de récupération.'],
 ['CSV Appels d’offres','Import Excel en unités Erplain : SKU directs, quantités conservées, contrôle du produit et du poids ; routage GLS PHARMA.'],
 ['CSV commandes échantillons','Import Excel / CSV avec le format des appels d’offres, routage GLS et SKU Erplain directs.'],
 ['Achats fournisseurs','Module retrouvé : catalogue, besoins, modèles Excel, analyse, plans, groupes et historique. Reprise restante.'],
 ['Métachamps Shopify','Module d’import retrouvé ; reprise restante.'],
 ['Espace technique','Files locales et transporteurs visibles. Règles de choix transporteur modifiables. Reprise après réponse incertaine contrôlée.'],
 ['BC / BL Erplain LIVE','Connexion LIVE vérifiée. Création et suivi des documents pour les nouvelles commandes. Reprise historique suspendue.']
];
addView('coverage',`<div class="panel padded"><h2>Reprise fonctionnelle de l’archive</h2><p>Inventaire issu des routes et des écrans sources de l’ancienne plateforme. Les sections ci-dessous ne signifient pas que toutes leurs fonctions sont déjà opérationnelles.</p><table><thead><tr><th>Section existante</th><th>État V3</th></tr></thead><tbody>${coverage.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table></div>`);
const form=document.createElement('form');form.id='mapping-edit';form.innerHTML=`<h3>Ajouter ou modifier une correspondance</h3><div class="form-grid"><label>Canal<select name="channel">${['amazon','shopify','temu','rakuten'].map(c=>`<option value="${c}">${labels[c]||c}</option>`).join('')}</select></label>${[['source_sku','SKU source','text'],['target_sku','SKU Erplain','text'],['source_qty','Quantité source','number'],['target_qty','Quantité Erplain','number'],['notes','Notes','text']].map(([n,t,type])=>`<label>${t}<input name="${n}" type="${type}" ${type==='number'?'min="0.000001" step="any" value="1"':''} ${n==='notes'?'':'required'}></label>`).join('')}</div><button class="primary">Enregistrer la correspondance</button><button type="button" id="mapping-delete">Supprimer cette correspondance</button><p id="mapping-feedback" role="status" aria-live="polite"></p><hr>`;
$('view-mappings').querySelector('.panel').insertBefore(form,$('mapping-search'));
form.onsubmit=async e=>{e.preventDefault();const feedback=$('mapping-feedback'),submit=form.querySelector('button.primary');submit.disabled=true;feedback.textContent='Enregistrement en cours…';try{await api('/api/mappings/save',Object.fromEntries(new FormData(form)));feedback.textContent='Correspondance enregistrée. La liste des SKU à mapper est recalculée au prochain export.';flash(feedback.textContent);await mappings();}catch(e){feedback.textContent='Enregistrement impossible : '+displayErrorMessage(e);flash(e,true);}finally{submit.disabled=false;}};
$('mapping-delete').onclick=async()=>{const b=Object.fromEntries(new FormData(form));if(!b.source_sku||!confirm('Supprimer la correspondance '+b.source_sku+' ?'))return;try{await api('/api/mappings/delete',b);await mappings();flash('Correspondance supprimée');}catch(e){flash(e,true);}};
const dialog=document.createElement('dialog');dialog.id='order-dialog';dialog.innerHTML='<button id="close-detail">Fermer</button><div id="order-detail"></div>';document.body.append(dialog);$('close-detail').onclick=()=>dialog.close();
let orderDetailRequestVersion=0;
function invalidateOrderDetailReads(){orderDetailRequestVersion++;if(dialog.open)dialog.close();}
function orderDetailIsCurrent(request){return !!request&&request.version===orderDetailRequestVersion&&request.user===user&&request.view===currentView&&dialog.open;}
function showOrderDetailReadError(request,error){if(!orderDetailIsCurrent(request))return;const message=document.createElement('p');message.className='resolution-diagnostic';message.setAttribute('role','status');message.textContent=displayErrorMessage(error);$('order-detail').append(message);flash(error,true);}
const closeOrderDetailDialog=dialog.close.bind(dialog);dialog.close=function(...args){orderDetailRequestVersion++;return closeOrderDetailDialog(...args);};
dialog.addEventListener('cancel',()=>{orderDetailRequestVersion++;});
async function orderDetail(id){if(typeof invalidateResolutionContextReads==='function')invalidateResolutionContextReads();const request={version:++orderDetailRequestVersion,id,user,view:currentView};try{$('order-detail').innerHTML='<p role="status">Chargement de la commande…</p>';if(!dialog.open)dialog.showModal();const {order:o,lines,jobs}=await api('/api/order-detail?id='+encodeURIComponent(id));if(!orderDetailIsCurrent(request))return null;if(o.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');$('order-detail').innerHTML=`<h2>${esc(o.reference)}</h2>${isDeliveredOrder(o)?'<p>Livrée · aucun problème à gérer</p>':''}<p>${esc(o.recipient)} · ${esc(o.address.street)} · ${esc(o.address.postal)} ${esc(o.address.city)} · ${esc(o.address.country)}</p><p>BC LIVE : ${esc(o.erp_live?.bc?.label||"Non créé")} · BL LIVE : ${esc(o.erp_live?.bl?.label||"Non créé")}</p><table><thead><tr><th>SKU source</th><th>Quantité</th><th>SKU Erplain</th><th>Quantité Erplain</th></tr></thead><tbody>${lines.map(l=>`<tr>${[l.source_sku,l.quantity,l.target_sku,l.target_quantity].map(x=>`<td>${esc(x??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table>${(isDeliveredOrder(o)||hasCompleteOrderDocuments(o))?'<details><summary>Historique des traitements</summary>':'<h3>Traitements</h3>'}${jobs.map(j=>`<p>${esc(j.kind)} : ${esc(j.status)} · ${errorDetailsHtml(j.error||'')}</p>`).join('')}${(isDeliveredOrder(o)||hasCompleteOrderDocuments(o))?'</details>':''}<details><summary>Données du fichier source (prix et champs importés)</summary><pre>${esc(JSON.stringify({commande:o.source_payload,lignes:lines.map(l=>l.source_payload)},null,2))}</pre></details>`;return request;}catch(e){if(orderDetailIsCurrent(request)){$('order-detail').innerHTML='<p role="status">Le détail de la commande est momentanément indisponible : '+errorDetailsHtml(e)+'</p>';flash(e,true);}return null;}}
$('order-rows').addEventListener('click',e=>{const b=e.target.closest('[data-detail]');if(b)orderDetail(b.dataset.detail);});
setInterval(()=>{if(user&&!document.hidden&&currentView==='shipments')shipments().catch(()=>{});},5000);

$('order-rows').addEventListener('click',e=>{if(e.target.closest('[data-shipment]')){$('shipment-carrier').value='';$('shipment-search').value='';show('shipments');}});

$('import-kind').add(new Option('Commandes échantillons · XLSX / CSV','samples'));$('channel').add(new Option('Échantillons','samples'));labels.samples='Échantillons';

$('view-mappings').querySelector('thead tr').insertAdjacentHTML('beforeend','<th>Notes</th><th>Mise à jour</th><th></th>');
const mp=document.createElement('div');mp.className='pagination';mp.innerHTML='<button id="mapping-prev">← Précédent</button><a href="/api/mappings/export">Exporter tous les mappings Excel</a><button id="mapping-next">Suivant →</button>';$('view-mappings').querySelector('.panel').append(mp);
$('mapping-prev').onclick=()=>{mappingPage=Math.max(1,mappingPage-1);mappings().catch(e=>flash(e,true));};$('mapping-next').onclick=()=>{mappingPage=Math.min(mappingPages,mappingPage+1);mappings().catch(e=>flash(e,true));};
$('status').add(new Option('Étiquette transporteur TEST','sandbox_ready'));
const previousSelection=selection;selection=()=>{previousSelection();$('sandbox-labels').disabled=!selected.size||!['admin','manager','operator'].includes(user?.role);};

$('status').add(new Option('Étiquette transporteur PROD','production_ready'));
