function partialWeightText(value){const weight=Number(value);return Number.isFinite(weight)&&weight>0?String(Number(weight.toPrecision(12))):'—';}
function cancelledStockRestoreHtml(id,h){return h.stockId&&h.message?.startsWith('BL annulé :')?'<button class="link-button" data-restore-cancelled-stock="'+esc(id)+'" data-stock-id="'+esc(h.stockId)+'">Rétablir le stock du BL '+esc(h.bl)+' annulé</button>':'';}

const partialStatuses={erplain_wait:'Erplain temporairement indisponible - reprise automatique programmee',draft_confirmed:'Brouillon BL conserve',lines_confirmed:'Lignes du BL confirmees',bl_confirmed:'BL confirme',selecting_lines:'Preparation des lignes du BL',bl_only:'BL créé · préparation de l’étiquette TEMU',temu_wait:'Étiquette TEMU · récupération automatique',temu_confirm:'Étiquette TEMU · achat à confirmer',temu_ready_review:'BL partiel · rapprochement requis',queued:'Préparation en attente',creating_bl:'Création du BL',draft_ready:'Vérification du BL',publishing_bl:'Validation du BL',creating_stock:'Mise à jour du stock',bl_ready:'BL prêt, étiquette en attente',creating_label:'Création de l’étiquette',awaiting_pdf:'Récupération du PDF',ready:'BL et étiquette prêts',review:'À vérifier',cancelled:'BL annulé — ancienne étiquette conservée'};
function partialLabelCanResume(d){if(d.label_choice==='bl_only_temu')return false;return d.status==='review'&&(['bl_ready','awaiting_pdf','finalizing_bl','recovered_bl'].includes(d.stage)||d.stage==='creating_label'&&d.environment==='production'&&d.bl?.id&&!d.documents&&!d.tracking?.length&&d.error==='Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS');}

// A released local attempt is history, not an Erplain BL cancellation.
function isClosedPartialAttempt(d){return d.status==='cancelled'&&d.stage==='cancelled'&&d.error?.startsWith('Tentative locale non créée clôturée après rapprochement du stock')&&!d.bl?.id&&!d.bl?.label&&Number(d.documents)===0&&Array.isArray(d.tracking)&&d.tracking.length===0;}
function partialStatusText(d){return isClosedPartialAttempt(d)?'Préparation clôturée — aucun BL créé':partialStatuses[d.status]||d.status;}
function partialBlText(d,fallback='En attente'){return isClosedPartialAttempt(d)?'Aucun BL créé':d.bl?.label||fallback;}

Object.assign(labels,{partial:'Livraisons partielles',partial_pending:'Préparation partielle',partial_created:'BL partiel créé',superseded:'Ancienne étiquette remplacée'});

const partialDialog=document.createElement('dialog');partialDialog.className='partial-quantity-dialog';partialDialog.innerHTML='<button id="partial-close">Fermer</button><h2>Préparer une livraison partielle</h2><p id="partial-order"></p><p id="partial-intro">Indiquez les quantités à envoyer. Le transport conserve le circuit de la commande.</p><div id="partial-content"></div>';document.body.append(partialDialog);$('partial-close').onclick=()=>{partialPreviewVersion++;partialDraft=null;partialDialog.close();};

let partialDraft=null,partialPreviewVersion=0;
const partialPreviewReads=new Map();
function pendingPartialPreview(id){let pending=partialPreviewReads.get(id);if(!pending){pending=api('/api/partial/preview?id='+encodeURIComponent(id));partialPreviewReads.set(id,pending);const clear=()=>{if(partialPreviewReads.get(id)===pending)partialPreviewReads.delete(id)};pending.then(clear,clear)}return pending;}

const baseDetail=orderDetail;orderDetail=async function(id){const request=await baseDetail(id);if(!orderDetailIsCurrent(request))return null;const button=document.createElement('button');button.className='primary';button.textContent='Préparer une livraison partielle';button.hidden=!['admin','manager','operator'].includes(user.role);button.onclick=()=>openPartial(id);$('order-detail').prepend(button);return request;};

async function readPartialPreview(id,onProgress,isCurrent=()=>true){

 const start=Date.now();
 const interval=setInterval(()=>onProgress(Math.floor((Date.now()-start)/1000)),1000);
 // Keep observing the shared read after 60 seconds: dropping its late result
 // stranded the form although Erplain had finally confirmed the stock.
 try{for(let attempt=0;;attempt++){try{return await pendingPartialPreview(id);}catch(error){
   const temporary=[429,502,503,504].includes(error.status)||/Erplain HTTP 429|quota partagé|API Erplain.*(?:502|503|504)/i.test(error.message);
   if(!temporary||attempt>=2||!isCurrent())throw error;
   await new Promise(resolve=>setTimeout(resolve,3000));if(!isCurrent())throw error;
  }}}finally{clearInterval(interval);}

}

function cachedPartialPreview(o){
 if(!o?.erp_live?.bc?.id)return null;const bc=o.erp_live.bc;
 const source=(bc.line_items||[]).filter(l=>l.variant).map(l=>({lineId:String(l.id),sku:l.variant.sku,quantity:Number(l.quantity),variantId:String(l.variant.id),locationId:String(l.location?.id||''),tracked:l.variant.track_inventory!==false}));
 const allocations=new Map((o.partial_allocation||[]).map(l=>[l.sku,Number(l.allocated)||0]));
 const raws=source.length?source:(o.sku_lines||[]).map((l,i)=>({lineId:'pending:'+i,sku:l.sku||l.target_sku||l.source_sku,quantity:Number(l.quantity||l.target_quantity||0),tracked:true}));
 const lines=raws.filter(l=>l.sku&&Number.isFinite(l.quantity)&&l.quantity>=0).map(l=>{const fulfilled=Math.min(l.quantity,allocations.get(l.sku)||0);allocations.set(l.sku,Math.max(0,(allocations.get(l.sku)||0)-fulfilled));return {...l,ordered:l.quantity,fulfilled,remaining:Math.max(0,l.quantity-fulfilled),available:Math.max(0,l.quantity-fulfilled),stockUsable:null,reserved:0}});
 return lines.length?{order:o,bc,lines,stockHolds:o.erp_live.documentSource?.stockHolds||o.erp_live.partialSource?.stockHolds||[]}:null;
}
function partialTypedValues(){return [...partialDialog.querySelectorAll('[data-partial-line]')].map(el=>({lineId:el.dataset.partialLine,sku:el.dataset.partialSku,value:el.value}));}
function partialRestoredValue(line,values,lines){const exact=values.find(v=>v.lineId===line.lineId&&v.sku===line.sku);if(exact)return exact.value;const pending=values.filter(v=>(line.lineId.startsWith('pending:')||v.lineId.startsWith('pending:'))&&v.sku===line.sku);return pending.length===1&&lines.filter(l=>l.sku===line.sku).length===1?pending[0].value:'';}
async function openPartial(id,keepValues=false){
 if(typeof invalidateResolutionContextReads==='function')invalidateResolutionContextReads();
 const values=keepValues?partialTypedValues():[],version=++partialPreviewVersion,readerUser=user,readerView=currentView;dialog.close();if(!partialDialog.open)partialDialog.showModal();$('partial-order').textContent='';$('partial-content').textContent='Chargement des lignes de la commande…';partialDraft=null;let verified=false,finished=false;
 const current=()=>version===partialPreviewVersion&&partialDialog.open&&readerUser===user&&readerView===currentView;
 const progress=seconds=>{if(!current())return;const message='Vérification du stock et des livraisons Erplain · '+seconds+' s'+(seconds>=60?' · Erplain répond lentement. La lecture reste suivie automatiquement ; vos quantités sont conservées.':seconds>=15?' · Appels Erplain partagés en attente. Vos quantités saisies sont conservées.':'');if($('partial-reading'))$('partial-reading').textContent=message;else $('partial-content').textContent=message;};
 try{
  const known=typeof partialVisibleOrders!=='undefined'?partialVisibleOrders.get(id):null,cached=cachedPartialPreview(known);if(cached)renderPartialForm(id,cached,false,values);
  else api('/api/order-detail?id='+encodeURIComponent(id)).then(r=>{if(!current()||finished||r.order?.id!==id)return;const o={...r.order,sku_lines:r.order.sku_lines||r.lines?.map(l=>({sku:l.target_sku||l.source_sku,quantity:l.target_quantity||l.quantity}))};const initial=cachedPartialPreview(o);if(initial)renderPartialForm(id,initial,false,values);}).catch(()=>{});
  const fresh=await readPartialPreview(id,progress,current);finished=true;if(!current())return;if(fresh.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');const typed=partialTypedValues();verified=true;partialDraft={id,requestId:crypto.randomUUID()};renderPartialForm(id,fresh,true,typed);if(fresh.order.channel!=='temu')partialHistory(id).catch(e=>{if(current()&&$('partial-history'))$('partial-history').textContent=displayErrorMessage(e);});
 }catch(e){finished=true;if(!current())return;partialDraft=null;for(const cell of partialDialog.querySelectorAll('[data-partial-stock]'))cell.textContent='Stock non vérifié';const status=$('partial-reading'),message=displayErrorDetail(e)+' Vos quantités sont conservées ; la création reste désactivée.';if(status)status.textContent=message;else $('partial-content').textContent=message;const retry=document.createElement('button');retry.textContent='Relire le stock et les livraisons';retry.onclick=()=>openPartial(id,true);$('partial-content').append(document.createElement('br'),retry);}
}
function renderPartialForm(id,s,verified=false,values=[]){
 const blOnly=s.order.channel==='temu';$('partial-intro').textContent=blOnly?'Le BL partiel sera créé puis passé à Prêt à livrer si le statut Erplain le permet. L’étiquette sera préparée via TEMU pour les seuls articles sélectionnés. Le montant sera présenté avant achat ; les étiquettes existantes sont conservées.':'Indiquez les quantités à envoyer. Un BL sera créé dans Erplain LIVE et une étiquette GLS/GOFO en production pour cet envoi.';const stockHolds=s.stockHolds||[];const shortages=verified?s.lines.filter(l=>l.remaining>0&&l.available===0):[];

 $('partial-order').textContent=s.order.reference+' · BC '+s.order.erp_live.bc.label;
 $('partial-content').innerHTML=`<p id="partial-reading" role="status">${verified?'Stock et livraisons vérifiés dans Erplain LIVE.':'Saisissez vos quantités. Vérification du stock Erplain en cours ; création du BL désactivée jusqu’à confirmation.'}</p>${stockHolds.length?'<p role="alert">'+stockHolds.map(h=>esc(h.bl)+' · '+esc(h.stockLabel)+' : '+esc(h.message)+cancelledStockRestoreHtml(id,h)).join('<br>')+'</p>':''}${shortages.length&&!stockHolds.length?'<p role="status"><strong>'+shortages.map(l=>esc(l.sku)+' · '+l.remaining+' unité(s) restant à livrer · Stock disponible : 0').join('<br>')+'</strong><br>Enregistrez l’entrée de stock dans Erplain LIVE, puis cliquez sur « Actualiser le stock et les livraisons ».</p>':''}<div class="partial-table-scroll"><table class="partial-quantities"><thead><tr><th>SKU Erplain</th><th>Commande initiale</th><th>Déjà livré*</th><th>Reste à livrer</th><th>Stock disponible</th><th>À envoyer avec ce BL</th></tr></thead><tbody>${s.lines.map(l=>`<tr><td>${esc(l.sku)}</td><td class="partial-readonly">${l.ordered}</td><td class="partial-readonly">${l.fulfilled}</td><td class="partial-readonly">${Math.max(0,l.ordered-l.fulfilled)}${l.reserved?'<small>Dont '+l.reserved+' en préparation dans NEXTECH LOGISTIC V3</small>':''}</td><td class="partial-readonly" data-partial-stock>${!verified?'Vérification en cours':!l.tracked?'Non suivi dans Erplain':l.stockUsable===null?'Lecture impossible':l.stockUsable}</td><td><input type="number" min="0" max="${l.available||0}" step="any" value="" placeholder="0" data-partial-line="${esc(l.lineId)}" data-partial-sku="${esc(l.sku)}" aria-label="Quantité à envoyer ${esc(l.sku)}" ${stockHolds.length||l.available===null||l.available<=0?'disabled':''}><small>Maximum : ${l.available===null?'indisponible':l.available}</small></td></tr>`).join('')}</tbody></table></div><p>* Quantités déjà affectées aux bons de livraison Erplain, pas forcément reçues par le client.</p>${s.bc.update_stock?'<p>Le stock de ce BC a déjà été comptabilisé à la commande. Ce BL ne créera aucune nouvelle sortie de stock.</p>':''}<p>${blOnly?'Après le BL, le devis TEMU de cette livraison sera présenté pour confirmation de l’achat.':'Une nouvelle étiquette sera créée pour chaque nouveau BL. Les anciennes restent dans l’historique.'}</p><p>Le stock sera vérifié avant validation. Le solde restera à livrer.</p><button id="partial-submit" class="primary" disabled>${blOnly?'Créer le BL partiel et préparer l’étiquette TEMU':'Créer le BL LIVE et l’étiquette PROD'}</button><button id="partial-refresh">Actualiser le stock et les livraisons</button><p id="partial-message" role="status"></p><h3>Livraisons de cette référence externe</h3><div id="partial-history"></div>`;

 const inputs=[...partialDialog.querySelectorAll('[data-partial-line]')];const validate=()=>{let selected=false,valid=true;const stocks=new Map();for(const input of inputs){const line=s.lines.find(l=>l.lineId===input.dataset.partialLine),q=Number(input.value);input.setCustomValidity('');if(!Number.isFinite(q)||q<0||q>Number(input.max)){input.setCustomValidity('Quantité supérieure au stock ou au reste disponible');valid=false;}if(q>0){selected=true;if(verified&&line.tracked){const key=line.variantId+':'+line.locationId,total=(stocks.get(key)||0)+q;stocks.set(key,total);if(total>line.stockUsable){input.setCustomValidity('Stock cumulé insuffisant pour ce SKU');valid=false;}}}}if(stockHolds.length||!verified)valid=false;$('partial-submit').disabled=!selected||!valid;if($('partial-message'))$('partial-message').textContent=selected&&verified&&!valid?'Vérifiez les quantités : elles dépassent le stock ou le reliquat disponible, ou un blocage Erplain subsiste.':'';return selected&&valid;};for(const input of inputs)input.oninput=validate;for(const radio of partialDialog.querySelectorAll('[name=partial-label-choice]'))radio.onchange=validate;

 for(const input of inputs)input.value=partialRestoredValue(s.lines.find(l=>l.lineId===input.dataset.partialLine),values,s.lines);validate();
 $('partial-refresh').onclick=()=>openPartial(id,true);$('partial-submit').onclick=async()=>{if(!partialDraft||!validate())return;const selection=[...document.querySelectorAll('[data-partial-line]')].filter(el=>Number(el.value)>0).map(el=>({lineId:el.dataset.partialLine,quantity:Number(el.value)}));$('partial-submit').disabled=true;try{const r=await api('/api/partial/prepare',{...partialDraft,selection,labelChoice:blOnly?'bl_only_temu':'new'});partialDraft=null;$('partial-message').textContent='Préparation enregistrée. Traitement en cours : '+r.id;await partialHistory(id);}catch(e){$('partial-message').textContent=displayErrorMessage(e);validate();}};
 if(blOnly)partialHistory(id).catch(error=>{if(partialDialog.open&&partialDialog.dataset.orderId===id&&$('partial-history'))$('partial-history').textContent=displayErrorMessage(error);});
}

let partialHistoryReadVersion=0,partialHistorySettledVersion=0;
async function partialHistory(id){if(!partialDialog.open||partialDialog.dataset.orderId!==id)return;const read=++partialHistoryReadVersion,preview=partialPreviewVersion,readerUser=user,readerView=currentView;const current=()=>partialDialog.open&&partialDialog.dataset.orderId===id&&preview===partialPreviewVersion&&readerUser===user&&readerView===currentView&&read>=partialHistorySettledVersion;let r;try{r=await api('/api/partial/list?id='+encodeURIComponent(id));}catch(error){if(!current())return;partialHistorySettledVersion=read;throw error;}if(!current())return;partialHistorySettledVersion=read;if(!$('partial-history'))return;$('partial-history').innerHTML=r.rows.length?r.rows.map(d=>`<article><strong>${esc(partialBlText(d,'BL en préparation'))}</strong> · ${esc(partialStatusText(d))} · ${esc(d.carrier||'Transport à déterminer')} · ${partialWeightText(d.weight_kg)} kg · ${d.parcel_count||'—'} colis${d.label_choice==='bl_only_temu'?' · BL : '+esc(typeof erpStatusText==='function'?erpStatusText(d.bl?.status):d.bl?.status||'À vérifier'):''}<p>${d.selection.map(l=>esc(l.sku)+' : '+l.quantity).join(' ; ')}</p><p>Suivi : ${esc(d.tracking.join(', ')||(isClosedPartialAttempt(d)?'Sans expédition':'En attente'))} ${d.error?' · '+errorDetailsHtml(d.error):''}</p>${partialTemuActions(d)}${partialCancelAvailable(d)?`<button data-partial-cancel="${d.id}" data-partial-bl="${esc(d.bl.id)}" ${partialCancellationPending.has(d.id)?'disabled':''}>Annuler ce BL partiel</button>`:''}${partialLabelCanResume(d)?`<button data-partial-retry="${d.id}">Reprendre l’étiquette sans recréer le BL</button>`:''}${Array.from({length:d.documents},(_,i)=>`<a href="/api/partial/documents/${d.id}/${i}" target="_blank" rel="noopener">PDF ${d.environment==='production'?'PROD':d.environment==='test'?'TEST':'ENV. NON IDENTIFIÉ'} ${i+1}</a>`).join(' · ')}</article>`).join(''):'Aucune livraison partielle.';}

setInterval(()=>{if(partialDialog.open&&partialDraft?.id)partialHistory(partialDraft.id).catch(()=>{});else if(partialDialog.open&&$('partial-history')){const id=partialDialog.dataset.orderId;if(id)partialHistory(id).catch(()=>{});}},3000);

async function openRecoveredBl(id){
 partialPreviewVersion++;partialDraft=null;dialog.close();partialDialog.dataset.orderId=id;
 $('partial-order').textContent='Livraisons existantes';$('partial-intro').textContent='Le BL existe déjà dans Erplain. Vous pouvez lancer son étiquette sans créer de nouveau BC ou BL.';
 $('partial-content').innerHTML='<h3>BL récupérés et historique</h3><div id="partial-history">Chargement…</div>';
 if(!partialDialog.open)partialDialog.showModal();
 try{await partialHistory(id);}catch(e){if(partialDialog.dataset.orderId===id&&$('partial-history'))$('partial-history').textContent=displayErrorMessage(e);}
}

const originalOpenPartial=openPartial;openPartial=async (id,keepValues=false)=>{partialDialog.dataset.orderId=id;await originalOpenPartial(id,keepValues);};



partialDialog.addEventListener('click',async e=>{const b=e.target.closest('[data-partial-retry]');if(!b)return;b.disabled=true;try{await api('/api/partial/retry',{id:b.dataset.partialRetry});await partialHistory(partialDialog.dataset.orderId);}catch(error){flash(error,true);b.disabled=false;}});



const partialShipmentsPanel=document.createElement('div');partialShipmentsPanel.className='panel padded';partialShipmentsPanel.innerHTML='<h2>Livraisons partielles</h2><p>Les 100 dernières préparations ; BL, colis et suivi propres à chaque livraison.</p><div id="partial-shipment-list"></div>';if($('view-shipments'))$('view-shipments').append(partialShipmentsPanel);

async function partialShipmentList(){const r=await api('/api/partial/list');const carriers=[...$('shipment-carrier').selectedOptions].map(o=>o.value).filter(Boolean);const rows=r.rows.filter(d=>!carriers.length||carriers.includes(d.carrier?.startsWith('gls')?'gls':d.carrier));$('partial-shipment-list').innerHTML=rows.length?`<table><thead><tr><th>Commande</th><th>BL</th><th>Produits envoyés</th><th>Transport</th><th>État</th><th>Suivi</th><th>PDF</th></tr></thead><tbody>${rows.map(d=>`<tr><td><button class="link-button" data-partial-order="${d.order_id}">${esc(d.reference)}</button></td><td>${esc(partialBlText(d))}<button class="link-button" data-erplain-document-refresh="${esc(d.order_id)}" data-erplain-document-kind="bc">Actualiser le BC Erplain</button><button class="link-button" data-erplain-document-refresh="${esc(d.order_id)}" data-erplain-document-kind="bl">Actualiser le BL Erplain</button></td><td>${d.selection.map(l=>esc(l.sku)+' × '+l.quantity).join('<br>')}</td><td>${esc(d.carrier||'À déterminer')} · ${partialWeightText(d.weight_kg)} kg · ${d.parcel_count||'—'} colis</td><td>${esc(partialStatusText(d))}${partialTemuActions(d)}${d.error?'<small>'+errorDetailsHtml(d.error)+'</small>':''}</td><td>${esc(d.tracking.join(', ')||(isClosedPartialAttempt(d)?'Sans expédition':'En attente'))}</td><td>${Array.from({length:d.documents},(_,i)=>`<a href="/api/partial/documents/${d.id}/${i}" target="_blank" rel="noopener">PDF ${d.environment==='production'?'PROD':d.environment==='test'?'TEST':'ENV. NON IDENTIFIÉ'} ${i+1}</a>`).join('<br>')}</td></tr>`).join('')}</tbody></table>`:'Aucune livraison partielle pour ce transporteur.';}

partialShipmentsPanel.addEventListener('click',e=>{const b=e.target.closest('[data-partial-order]');if(b)orderDetail(b.dataset.partialOrder);});

const showWithPartial=typeof show==='function'?show:async()=>{};show=async function(view){await showWithPartial(view);if(view==='shipments')await partialShipmentList();};

setInterval(()=>{if(user&&!document.hidden&&typeof currentView!=='undefined'&&currentView==='shipments')partialShipmentList().catch(()=>{});},5000);



const partialStyle=document.createElement('style');partialStyle.textContent='.partial-quantity-dialog{width:min(1200px,94vw);max-width:94vw}.partial-table-scroll{overflow-x:auto}.partial-quantities{width:100%;table-layout:auto}.partial-quantities th,.partial-quantities td{min-width:125px;padding:12px;overflow-wrap:normal;word-break:normal}.partial-quantities .partial-readonly{background:#eef1f2;color:#475569}.partial-quantities small{display:block;margin-top:6px}.partial-quantities input{min-width:100px;width:110px;background:#fff}';document.head.append(partialStyle);



// Open the allocation form directly, without unrelated correction dialogs.

document.addEventListener('click',e=>{const b=e.target.closest('[data-prepare-partial]');if(!b)return;e.preventDefault();openPartial(b.dataset.preparePartial);});

const partialFilter=document.getElementById('problem-type');if(partialFilter&&!partialFilter.querySelector('option[value=partial]')){const option=document.createElement('option');option.value='partial';option.textContent='Quantités restant à allouer';partialFilter.append(option);}



// Explicit recovery queues missing labels for eligible associated BLs.

document.addEventListener('click',async e=>{const b=e.target.closest('[data-erplain-document-refresh]');if(!b)return;e.preventDefault();if(b.disabled)return;b.disabled=true;const original=b.innerHTML,originalLabel=b.getAttribute('aria-label'),originalTitle=b.getAttribute('title');b.setAttribute('aria-busy','true');b.setAttribute('aria-label','Lecture Erplain en cours');b.title='Lecture Erplain en cours';if(!b.classList.contains('order-icon-action'))b.textContent='Lecture Erplain…';try{const r=await api('/api/erplain/documents/refresh',{id:b.dataset.erplainDocumentRefresh,kind:b.dataset.erplainDocumentKind});flash(r.stockHolds?.length?r.stockHolds.map(h=>h.bl+' · '+h.message).join('; '):r.message,!!r.stockHolds?.length||!!r.labelHolds?.length||!!r.notFound);window.getSelection()?.removeAllRanges();preparedOrderResponse=null;await orders();if(currentView==='shipments')await partialShipmentList();if(currentView==='temu')await temuLoad();document.dispatchEvent(new CustomEvent('erplain-documents-refreshed',{detail:{id:b.dataset.erplainDocumentRefresh}}));}catch(error){flash(error,true);}finally{b.disabled=false;b.innerHTML=original;b.removeAttribute('aria-busy');if(originalLabel===null)b.removeAttribute('aria-label');else b.setAttribute('aria-label',originalLabel);if(originalTitle===null)b.removeAttribute('title');else b.setAttribute('title',originalTitle);}});





// The repair is explicit, unlike BC/BL refresh. It cancels only the verified linked stock removal.

document.addEventListener('click',async e=>{const b=e.target.closest('[data-restore-cancelled-stock]');if(!b)return;e.preventDefault();if(b.disabled)return;b.disabled=true;const original=b.textContent;b.textContent='Restitution du stock dans Erplain…';try{const r=await api('/api/erplain/stock/restore-cancelled',{id:b.dataset.restoreCancelledStock,stockId:b.dataset.stockId});flash(r.message);await orders();if(partialDialog.open&&partialDialog.dataset.orderId===b.dataset.restoreCancelledStock)await openPartial(b.dataset.restoreCancelledStock);}catch(error){flash(error,true);if(partialDialog.open){const status=document.createElement('p');status.setAttribute('role','alert');status.textContent=displayErrorMessage(error);$('partial-content').prepend(status);}}finally{b.disabled=false;b.textContent=original;}});


const partialCancellationPending=new Set();
function partialCancelAvailable(d){return d.bl?.id&&!d.documents&&!d.tracking?.length&&((d.status==='cancelled'&&d.stock_document?.status!=='cancelled')||d.status==='bl_ready'||(d.status==='review'&&(['bl_ready','finalizing_bl','cancelling_bl','restoring_cancelled_stock'].includes(d.stage)||d.stage==='creating_label'&&['Appels d’offres · Client et destinataire dépassent les trois lignes GLS : vérifier avant création','Appels d’offres · Numéro de téléphone absent ou invalide : renseigner un numéro joignable avant création de l’étiquette GLS'].includes(d.error))));}
partialDialog.addEventListener('click',async e=>{const button=e.target.closest('[data-partial-cancel]');if(!button||partialCancellationPending.has(button.dataset.partialCancel))return;const id=partialDialog.dataset.orderId,version=partialPreviewVersion,readerUser=user,readerView=currentView;if(!id)return;const current=()=>partialDialog.open&&partialDialog.dataset.orderId===id&&version===partialPreviewVersion&&readerUser===user&&readerView===currentView;if(!confirm('Annuler uniquement ce BL partiel et restituer sa sortie de stock vérifiée ? Le BC et les anciennes étiquettes sont conservés.'))return;partialCancellationPending.add(button.dataset.partialCancel);button.disabled=true;try{const r=await api('/api/partial/cancel',{id,deliveryId:button.dataset.partialCancel,blId:button.dataset.partialBl});if(!current())return;await openPartial(id,true);if(partialDialog.open&&partialDialog.dataset.orderId===id&&$('partial-message'))$('partial-message').textContent=r.message;}catch(error){if(current()&&$('partial-message'))$('partial-message').textContent=displayErrorMessage(error);}finally{partialCancellationPending.delete(button.dataset.partialCancel);button.disabled=false;}});

function partialTemuActions(d){
 if(d.label_choice!=='bl_only_temu'||!['admin','manager','operator'].includes(user?.role))return '';
 const plan=d.temu_label?.plan;
 const buy=d.status==='temu_confirm'&&plan&&!d.temu_label?.attemptId&&plan.expiresAt>Date.now();
 return (buy?`<p>${esc(plan.carrier)} · ${esc(plan.amount)} ${esc(plan.currency)}<button data-partial-temu-buy="${esc(d.id)}" data-plan-id="${esc(plan.id)}" data-amount="${esc(plan.amount)}" data-currency="${esc(plan.currency)}">Acheter l’étiquette TEMU · ${esc(plan.amount)} ${esc(plan.currency)}</button></p>`:'')+(['bl_only','temu_wait','temu_confirm','temu_ready_review'].includes(d.status)?`<button data-partial-temu-refresh="${esc(d.id)}">${d.temu_label?.attemptId?'Récupérer l’étiquette TEMU existante':'Actualiser l’étiquette TEMU'}</button>`:'');
}
document.addEventListener('click',async e=>{
 const b=e.target.closest('[data-partial-temu-buy],[data-partial-temu-refresh]');if(!b||b.disabled)return;
 const purchase=!!b.dataset.partialTemuBuy,id=b.dataset.partialTemuBuy||b.dataset.partialTemuRefresh;
 if(purchase&&!confirm('Acheter cette étiquette TEMU pour '+b.dataset.amount+' '+b.dataset.currency+' ?'))return;
 b.disabled=true;try{await api(purchase?'/api/partial/temu/buy':'/api/partial/temu/refresh',{id,...(purchase?{planId:b.dataset.planId,amount:Number(b.dataset.amount),confirmPurchase:true}:{})});if(partialDialog.open)await partialHistory(partialDialog.dataset.orderId);if(currentView==='shipments')await partialShipmentList();if(currentView==='orders')await orders();}catch(error){flash(error,true);}finally{b.disabled=false;}
});

// The associated BL gets its own shipment; the original label stays available.
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-existing-bl-label]');if(!button)return;event.preventDefault();
 if(button.disabled)return;button.disabled=true;const original=button.textContent;button.textContent='Vérification du BL…';
 button.dataset.requestId ||= crypto.randomUUID();
 try{const result=await api('/api/partial/existing-bl-label',{id:button.dataset.existingBlOrder,blId:button.dataset.existingBlLabel,requestId:button.dataset.requestId});flash(result.existing?(result.error||'Une demande existe déjà pour ce BL. Consultez sa ligne de livraison.'):'Étiquette du BL '+button.dataset.existingBlName+' mise en génération. Une ligne séparée affichera son suivi et son PDF.',!!result.error);await orders();}
 catch(error){flash(error.message,true);}
 finally{button.disabled=false;button.textContent=original;}
});
