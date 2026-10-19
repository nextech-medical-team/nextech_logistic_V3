let resolutionContextRequestVersion=0;
function temuRefusalDetailsHtml(problem,ctx){
 if(problem.type!=='temu-label-refused')return '';
 const reasons=ctx.temuJob?.refusalReasons||ctx.order?.temu_job?.refusalReasons||[];
 if(!reasons.length)return '<p>TEMU ne fournit pas de motif original supplémentaire dans les données enregistrées. Actualisez les informations TEMU pour relire le refus.</p>';
 return '<h3>Motif exact renvoyé par TEMU</h3>'+reasons.map(p=>'<p class="resolution-diagnostic">'+(p.packageSn?'Colis '+esc(p.packageSn)+' : ':'')+esc(p.reason||'Motif non communiqué par TEMU.')+'</p>').join('');
}
function invalidateResolutionContextReads(){resolutionContextRequestVersion++;}
function resolutionContextIsCurrent(request){return request.version===resolutionContextRequestVersion&&request.user===user&&request.view===currentView;}
function sharedParcelResolutionNotice(problem,order){
 const reason='Colis partagé entre plusieurs commandes';
 if(order?.channel!=='temu'||problem?.type!=='unknown'||String(problem.detail||problem.label||'').trim()!==reason)return null;
 return {description:'Plusieurs commandes sont associées au même colis TEMU. Ce regroupement n’est pas une erreur. Cette commande attend une reprise de ses contrôles Erplain : produits, quantités, stock et documents existants. L’étiquette et le numéro de suivi sont conservés ; aucun nouvel achat n’est demandé et les autres commandes du colis ne sont pas relancées.',button:'Reprendre les contrôles BC/BL — étiquette conservée'};
}

function temuLabelResolutionNotice(problem,order){
 if(order?.channel!=='temu')return null;
 const text=String(problem.detail||problem.label||'');
 if(/shipping address contains non-English characters|Adresse\s*:\s*caractères refusés|adresse avec caractères non pris en charge/i.test(text))return 'TEMU refuse les caractères de l’adresse pour ce service de livraison. Vérifiez et corrigez les coordonnées dans TEMU Seller Center, puis relisez le résultat de l’expédition existante. Modifier uniquement l’adresse dans V3 ne corrige pas ce refus chez TEMU. Si vous disposez déjà d’une étiquette achetée à l’extérieur, vous pouvez l’enregistrer ici.';
 if(problem.type==='temu-label-refused')return 'TEMU a refusé cette étiquette. Consultez le motif ci-dessous et corrigez le problème dans TEMU Seller Center, puis relisez l’expédition existante. Si vous disposez déjà d’une étiquette achetée à l’extérieur, vous pouvez l’enregistrer ici.';
 return null;
}

function mappingQuantityDefaults(line={}){



 const p=line.source_payload||{},source=Number(p.mappingSourceQty??line.source_qty),target=Number(p.mappingTargetQty??line.target_qty);



 if(Number.isFinite(source)&&source>0&&Number.isFinite(target)&&target>0)return {source,target};



 const quantity=Number(line.quantity),resolved=Number(line.target_quantity);



 if(Number.isFinite(quantity)&&quantity>0&&Number.isFinite(resolved)&&resolved>0)return {source:quantity,target:resolved};



 return {source:1,target:1};



}



function sourceProductName(line){



 const payload=line?.source_payload;



 if(!payload||typeof payload!=='object')return '';



 const normalized=Object.fromEntries(Object.entries(payload).map(([k,v])=>[k.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,''),v]));



 for(const key of ['productname','goodsname','itemname','name','title','produits','nomproduit','designation','libelle']){



  const value=normalized[key];if(typeof value==='string'&&value.trim())return value.trim().replace(/\s+/g,' ');



 }



 return '';



}



const resolutionViews={



 'temu-pricing':{title:'TEMU · Renseigner les prix et quantités',view:'temu-pricing'},



 platform:{title:'Modification de la commande sur la plateforme',view:'platform'},



 'erplain-recovery':{title:'Vérifier Erplain et reprendre le BL',view:'erp-recovery'},
 preparation:{title:'Validation stock / BL à actualiser',view:'preparation'},
 'historical-preparation':{title:'Reprise historique · BL manquant',view:'historical'},



 mapping:{title:'Mapping manquant',view:'mapping'},missing:{title:'SKU Erplain introuvable',view:'product'},



 inactive:{title:'Produit inactif dans Erplain',view:'product'},duplicate:{title:'SKU en doublon dans Erplain',view:'product'},



 weight:{title:'Poids manquant',view:'weight'},'weight-unit':{title:'Unité de poids invalide',view:'weight'},



 address:{title:'Adresse à compléter',view:'address'},city:{title:'Ville refusée par GOFO',view:'address'},



 routing:{title:'Règle transport manquante',view:'routing'},stock:{title:'Stock insuffisant',view:'stock'},bc:{title:'Commande V3 et BC différents',view:'bc'},



 relay:{title:'Aucun relais GLS trouvé',view:'relay'},'relay-search':{title:'Recherche du relais GLS',view:'relay'},



 uncertain:{title:'Création transport à vérifier',view:'uncertain'},pdf:{title:'PDF en attente',view:'pdf'},



 'api-access':{title:'API · Accès refusé',view:'api'},'api-limit':{title:'API · Limite atteinte',view:'api'},'api-server':{title:'API · Erreur serveur',view:'api'},



 'api-timeout':{title:'API · Délai dépassé',view:'api'},'api-network':{title:'API · Connexion impossible',view:'api'},'api-stock':{title:'API Erplain · Stock non reçu',view:'stock'},



 'api-incomplete':{title:'API · Réponse incomplète',view:'api'},'api-http':{title:'API · Requête refusée',view:'api'},'erp-review':{title:'Erplain · Préparation à vérifier',view:'erp-review'},unknown:{title:'Motif du blocage',view:'unknown'}



};



function resolutionProblems(ctx){return compactProblems({...ctx.order,sku_lines:ctx.lines.map(l=>({source_sku:l.source_sku,sku:l.target_sku||l.mapped_sku,mapping_exists:!!l.mapped_sku,mapping_resolved:!!l.mapped_sku||!!l.target_sku&&Number(l.target_quantity)>0,catalog_issue:l.message,quantity:l.target_quantity??(Number(l.source_qty)>0?Number(l.quantity)*Number(l.target_qty)/Number(l.source_qty):l.quantity)})),carrier_job:ctx.job,erp_live_job:ctx.erpJob,temu_job:ctx.temuJob});}



async function refreshAndResumeOrder(id){



 if(typeof invalidateOrderDetailReads==='function')invalidateOrderDetailReads();const contextRequest={version:++resolutionContextRequestVersion,user,view:currentView};let ctx;try{ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));}catch(error){if(!resolutionContextIsCurrent(contextRequest))return;throw error;}if(!resolutionContextIsCurrent(contextRequest))return;if(ctx.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');if(isDeliveredOrder(ctx.order)){const d=resolutionDialog('Commande livrée',ctx.order.reference);d.body.textContent='Livrée · aucun problème à gérer';return;}



 const d=resolutionDialog(ctx.active?'Traitement en cours':'Actualiser et reprendre la commande',ctx.order.reference);



 d.body.textContent=ctx.active?'Suivi du traitement déjà lancé.':'Recontrôle de la préparation, du stock et des documents Erplain avant l’étiquette.';



 try{await d.job(ctx,'refresh','unknown');await orders();}catch{}



}



document.addEventListener('click',event=>{const b=event.target.closest?.('[data-resume-order]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();refreshAndResumeOrder(b.dataset.resumeOrder).catch(e=>flash(e,true));},true);



// Delegation also handles the initial async render and rows replaced by filters.



document.addEventListener('click',event=>{const b=event.target.closest?.('[data-exact-problem]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();openCorrection(b.dataset.exactProblem,b.dataset.problemType,b.dataset.problemSku,b.dataset.problemDetail).catch(e=>flash(e,true));},true);



document.addEventListener('click',event=>{const b=event.target.closest?.('[data-replace-product]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();openOrderReplacement(b.dataset.replaceProduct).catch(e=>flash(e,true));},true);



const correctionRows=orders;



orders=async function(){await correctionRows();for(const row of $('order-rows').rows){const id=row.querySelector('[data-detail]')?.dataset.detail;if(!id)continue;



 const headers=[...(row.closest('table')?.tHead?.rows[0]?.cells||[])],skuIndex=headers.findIndex(h=>/^SKU\b/i.test(h.textContent.trim())),skuCell=row.cells[skuIndex];



 if(row.dataset.orderDelivered!=='true'&&skuCell&&!skuCell.querySelector('[data-replace-product]')){const replace=document.createElement('button');replace.type='button';replace.className='link-button';replace.dataset.replaceProduct=id;replace.textContent='Remplacer un produit';skuCell.append(replace);}



 for(const b of row.querySelectorAll('[data-exact-problem]'))b.onclick=()=>openCorrection(id,b.dataset.problemType,b.dataset.problemSku,b.dataset.problemDetail).catch(e=>flash(e,true));



 const cell=row.cells[row.cells.length-2];if(!cell?.matches('[data-platform-status],[data-erplain-tracking]')&&!cell?.querySelector('[data-exact-problem]'))for(const b of cell?.querySelectorAll('.badge')||[])if(/compléter|vérifier|erreur|attente/i.test(b.textContent)){const button=document.createElement('button');button.textContent=b.textContent;button.className=b.className;button.onclick=()=>openCorrection(id).catch(e=>flash(e,true));b.replaceWith(button);}



}};



const detailBeforeResolution=orderDetail;



orderDetail=async function(id){const request=await detailBeforeResolution(id);if(!orderDetailIsCurrent(request))return null;for(const b of $('order-detail').querySelectorAll('button'))if(b.textContent==='Compléter les informations et créer l’étiquette'){b.textContent='Résoudre un problème';b.onclick=()=>{dialog.close();openCorrection(id).catch(e=>flash(e,true));};}return request;};







function recordedResolution(action,result){



 return !!result&&((action==='replace-equivalent'&&result.equivalent===true)||(action==='mapping'&&!!result.mapping)||(action==='weight'&&Number(result.product?.weightKg)>0));



}



function providerDiagnosticRows(result){
 const text=value=>typeof value==='string'||typeof value==='number'?String(value):'';
 const list=(values,describe)=>Array.isArray(values)?values.map((value,index)=>value&&typeof value==='object'?describe(value,index):'Observation '+(index+1)+' incomplète ; résultat à vérifier.'):[];
 const identities=value=>[value.packageSn,value.tracking,value.trackingNumber,value.orderSn].map(text).filter(Boolean).join(' · ');
 const statuses={delivered:'Livré',shipped:'Expédié',not_shipped:'Non expédié',in_transit:'En transit',unknown:'Statut non déterminé'};
 const rows=[];
 for(const value of list(result.packages,p=>[identities(p)||'Colis sans identifiant',Number(p.shippingLabelStatus)===1?'Étiquette disponible':Number(p.shippingLabelStatus)===2?'Étiquette refusée':'État de l’étiquette à vérifier',text(p.shippingCompanyName),text(p.failReasonText)].filter(Boolean).join(' · ')))rows.push({kind:'Colis TEMU',text:value});
 for(const value of list(result.shipments,p=>[identities(p)||'Identité d’expédition non fournie',text(p.shippingCompanyName),text(p.shipmentStatus),text(p.shippingTime)].filter(Boolean).join(' · ')))rows.push({kind:'Expédition reçue',text:value});
 for(const value of list(result.parcels,p=>[identities(p)||'Colis sans identifiant',p.labelAvailable===true?'Étiquette disponible':statuses[p.status]||text(p.status)||'Statut non fourni'].filter(Boolean).join(' · ')))rows.push({kind:'Suivi fournisseur',text:value});
 for(const p of Array.isArray(result.parcels)?result.parcels:[]){if(!p||!Array.isArray(p.events))continue;for(const event of p.events){if(!event||typeof event!=='object'){rows.push({kind:'Événement reçu',text:'Événement incomplet ; résultat à vérifier.'});continue;}rows.push({kind:'Événement reçu',text:[identities(p),text(event.at),text(event.label)||text(event.description)||text(event.status)||text(event.code)||'Détail de l’événement non fourni'].filter(Boolean).join(' · ')});}}
 for(const error of Array.isArray(result.errors)?result.errors:[])rows.push({kind:'Lecture à vérifier',text:typeof error==='string'?error:[identities(error||{}),text(error?.message)||'Motif non fourni'].filter(Boolean).join(' · ')});
 for(const local of Array.isArray(result.local)?result.local:[])if(local?.error)rows.push({kind:'Erreur locale conservée',text:[text(local.kind),text(local.error)].filter(Boolean).join(' · ')});
 return rows;
}
function renderProviderDiagnostic(body,result){
 body.querySelector('[data-provider-result]')?.remove();
 const box=document.createElement('section');box.dataset.providerResult='true';box.className='resolution-provider-result';
 const title=document.createElement('h3');title.textContent='Diagnostic fournisseur '+(result.provider||'')+' · lecture seule';box.append(title);
 const time=document.createElement('p'),valid=typeof result.checkedAt==='string'&&Number.isFinite(Date.parse(result.checkedAt));time.textContent=valid?'Lecture effectuée : '+new Date(result.checkedAt).toLocaleString('fr-FR')+' ('+result.checkedAt+')':'Date de lecture fournisseur non fournie ou invalide : fraîcheur à vérifier.';box.append(time);
 const message=document.createElement('p');message.textContent=result.message||'Résultat fournisseur reçu sans résumé ; vérifiez les observations et les erreurs.';box.append(message);
 const list=document.createElement('ul');for(const row of providerDiagnosticRows(result)){const item=document.createElement('li');item.textContent=row.kind+' · '+row.text;list.append(item);}if(list.childElementCount)box.append(list);
 const note=document.createElement('p');note.textContent='Ce diagnostic décrit cette lecture fournisseur. Les autres problèmes de la commande restent à vérifier ; aucun achat ni aucune correction métier n’est confirmé par cette lecture.';box.append(note);body.append(box);
}

function resolutionDialog(title,reference){



 const modal=document.createElement('dialog');modal.className='resolution-dialog';modal.setAttribute('aria-label',title);



 modal.innerHTML='<header><h2>'+esc(title)+'</h2><button type="button" data-close>Fermer</button></header><p class="resolution-reference">Commande '+esc(reference)+'</p><div data-body></div><div class="resolution-progress"><p data-stage role="status" aria-live="polite"></p><small data-clock></small></div>';



 document.body.append(modal);modal.showModal();let timer,pollTimer,releasePoll,closed=false,queuedHandle=null,pendingRequest=null;



 const handle=modal.querySelector('header');handle.title='Faites glisser l’espace vide de l’en-tête pour déplacer la fenêtre';let drag=null;



 const place=(left,top)=>{const r=modal.getBoundingClientRect(),visible=Math.min(180,r.width);modal.style.left=Math.max(visible-r.width,Math.min(innerWidth-visible,left))+'px';modal.style.top=Math.max(8,Math.min(innerHeight-Math.min(64,r.height),top))+'px';};



 handle.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('h2,button,a,input,select,textarea'))return;const r=modal.getBoundingClientRect();modal.style.position='fixed';modal.style.margin='0';modal.style.inset='auto';modal.style.boxSizing='border-box';modal.style.width=r.width+'px';modal.style.left=r.left+'px';modal.style.top=r.top+'px';drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top};handle.setPointerCapture(e.pointerId);handle.classList.add('dragging');e.preventDefault();});



 handle.addEventListener('pointermove',e=>{if(drag?.id===e.pointerId)place(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y);});



 const release=e=>{if(drag?.id!==e.pointerId)return;drag=null;handle.classList.remove('dragging');};



 handle.addEventListener('pointerup',release);handle.addEventListener('pointercancel',release);handle.addEventListener('lostpointercapture',release);



 const resized=()=>{if(modal.style.left)place(parseFloat(modal.style.left),parseFloat(modal.style.top));};window.addEventListener('resize',resized);modal.addEventListener('close',()=>window.removeEventListener('resize',resized),{once:true});







 const warnUnload=e=>{if(modal.dataset.unsavedEquivalent){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warnUnload);modal.addEventListener('close',()=>window.removeEventListener('beforeunload',warnUnload),{once:true});
 const canClose=()=>{const warning=modal.dataset.unsavedEquivalent;if(!warning)return true;return window.confirm(warning);};
 modal.querySelector('[data-close]').onclick=()=>{if(canClose())modal.close();};
 modal.addEventListener('cancel',e=>{if(!canClose())e.preventDefault();});modal.addEventListener('close',()=>{closed=true;clearInterval(timer);clearTimeout(pollTimer);releasePoll?.();modal.remove();},{once:true});



 const body=modal.querySelector('[data-body]'),state=modal.querySelector('[data-stage]'),clock=modal.querySelector('[data-clock]');



 const disabledBeforeJob=new Map();
 function busy(on){if(on){disabledBeforeJob.clear();body.querySelectorAll('button,input,select,textarea').forEach(x=>{disabledBeforeJob.set(x,x.disabled);x.disabled=true;});}else{for(const [x,disabled]of disabledBeforeJob)if(x.isConnected)x.disabled=disabled;disabledBeforeJob.clear();}}



 function finished(ctx,success,message,review=false,recorded=false,providerDiagnostic=false){



  if(closed)return;



  modal.querySelector('[data-completion]')?.remove();



  const notice=document.createElement('section');notice.dataset.completion='true';notice.className='resolution-completion '+(success?'is-success':'is-warning');notice.setAttribute('role','alert');notice.tabIndex=-1;



  const title=document.createElement('h3');title.textContent=!success&&queuedHandle?'Lecture interrompue · demande enregistrée':!success&&pendingRequest?'Enregistrement à vérifier':providerDiagnostic?(success?'Diagnostic fournisseur terminé':'Diagnostic fournisseur partiel · vérification nécessaire'):success?'Traitement terminé':recorded?'Correction enregistrée · autre problème à résoudre':review?'Traitement arrêté · action nécessaire':'Traitement interrompu · résultat à vérifier';



  const detail=document.createElement('p');detail.textContent=(success?message:displayErrorMessage(message))||(success?'Vous pouvez maintenant vérifier la commande.':'Vérifiez la commande avant de relancer le traitement.');



  const view=document.createElement('button');view.type='button';view.textContent=queuedHandle||pendingRequest?'Vérifier le traitement enregistré':success?'Voir la commande':'Résoudre le problème restant';view.onclick=async()=>{modal.close();try{await orders();await openRemainingProblem(ctx.order.id);}catch(e){flash(e,true);}};



  notice.append(title,detail,view);body.before(notice);notice.focus();



  flash('Commande '+ctx.order.reference+' · '+title.textContent,!success);



 }



 async function job(ctx,action,type,data={}){



  if(closed)return null;modal.querySelector('[data-completion]')?.remove();body.querySelector('[data-result]')?.replaceChildren();body.querySelector('[data-reopen]')?.remove();body.querySelector('[data-provider-result]')?.remove();busy(true);let review=false,correctionRefreshed=false;const start=Date.now();state.textContent=ctx.active?'Suivi du traitement déjà en cours…':queuedHandle?'Relecture du traitement déjà enregistré…':pendingRequest?'Vérification de la demande précédente avec le même identifiant…':'Enregistrement de la demande…';clock.textContent='Demande V3 · enregistrement en cours';clearInterval(timer);



  try{



   let queued=ctx.active||queuedHandle;if(!queued){const requested={id:ctx.order.id,action,type,...data};if(pendingRequest){const {requestId,...previous}=pendingRequest;if(JSON.stringify(previous)!==JSON.stringify(requested))throw Error('L’enregistrement précédent reste à vérifier. Ne changez pas son contenu avant de vérifier la commande.');}else pendingRequest=JSON.parse(JSON.stringify({...requested,requestId:crypto.randomUUID()}));queued=await api('/api/resolutions',pendingRequest);}queuedHandle={...queued,action:queued.action||action,carrier:queued.carrier||data.carrier};pendingRequest=null;if((queued.action||action)==='replace-equivalent'){modal.dataset.equivalentSubmitted='true';delete modal.dataset.unsavedEquivalent;}



   let readFailures=0,receiptShown=false;



   while(!closed){let r;



    try{r=await api('/api/resolutions/job?id='+encodeURIComponent(queued.id),undefined,{timeoutMs:20000});readFailures=0;}



    catch(e){



     // Retry only the status GET, never the operation POST. The server job



     // survives a short gateway outage; losing its polling is not a failure.



     const temporary=e.retryable===true||e.code==='API_NETWORK_ERROR'||[429,502,503,504].includes(e.status)||/HTTP (?:429|502|503|504)\b|Failed to fetch|NetworkError|Load failed/i.test(String(e.message||''));



     if(!temporary||++readFailures>10)throw e;



     if(closed)break;



     clearInterval(timer);clock.textContent='État actuel non confirmé · lecture de suivi interrompue';
     state.textContent='Connexion momentanément interrompue. La demande est enregistrée ; vérification de son avancement en cours. Ne la relancez pas.';



     await new Promise(resolve=>{releasePoll=resolve;pollTimer=setTimeout(resolve,2000);});



     continue;



    }



    if(closed)break;



    queuedHandle.carrier=r.requested_carrier||queuedHandle.carrier;
    const receipt=ctx.order.channel!=='tender'&&r.action==='choose-carrier'&&r.requested_carrier?manualRequestFeedbackText(r.status,r.requested_carrier):null;
    state.textContent=r.error?displayErrorMessage(r.error):receipt||r.stage;if(receipt&&!r.error&&!receiptShown){flash(receipt);receiptShown=true;}
    clearInterval(timer);
    const observation=Date.now();let observedStatus=r.status,observedSince=r.state_since,observedService=['equivalent-preview','replace-equivalent','check-sku','compare-bc','weight','reconcile-bc'].includes(r.action||action)?'V3 → Erplain':'V3',observedStep=r.stage||'';
    if(r.status==='waiting'){try{const follow=await api('/api/orders/processing',{ids:[ctx.order.id]});const current=follow.rows?.[0];if(current?.manual_label_request)state.textContent=current.manual_label_request.message;if(current?.state){observedStatus=({active:'running',queued:'queued',blocked:'review'})[current.state];observedSince=current.since;observedService='V3 → '+current.service;observedStep=current.step;}}catch{observedStatus='unconfirmed';}}
    if(closed)break;
    const updateClock=()=>{const valid=observedSince&&Number.isFinite(new Date(observedSince).getTime());const duration=valid?Math.max(0,Math.floor((Date.now()-new Date(observedSince).getTime())/1000))+' s':'début non disponible';clock.textContent=observedService+' · '+(observedStatus==='running'?'traitement actif depuis '+duration:observedStatus==='queued'?'attente depuis '+duration:observedStatus==='waiting'?'suite du traitement en attente':['review','failed','cancelled'].includes(observedStatus)?'blocage depuis '+duration:observedStatus==='unconfirmed'?'état actuel non confirmé':'vérification terminée')+(observedStep?' · '+observedStep:'')+' · état reçu à '+new Date(observation).toLocaleTimeString('fr-FR');};updateClock();if(['running','queued','review'].includes(observedStatus))timer=setInterval(updateClock,1000);







    const effectiveAction=r.action||queuedHandle?.action||ctx.active?.action||action;



    const recorded=r.result?.readOnly!==true&&recordedResolution(effectiveAction,r.result);
    if(r.result?.readOnly===true)renderProviderDiagnostic(body,r.result);
    if(recorded)delete modal.dataset.unsavedEquivalent;
    if(recorded&&!r.error&&!['review','complete'].includes(r.status))state.textContent=effectiveAction==='replace-equivalent'?'Remplacement enregistré. '+(observedStatus==='review'?'Préparation bloquée : '+observedStep:observedStatus==='queued'?'Préparation en attente.':'Contrôle du stock et du BL en cours.')+' Vous pouvez fermer cette fenêtre ; le traitement continue dans V3.':(r.result.message||'Correction enregistrée.')+' Suite du traitement : '+(r.stage||r.status)+'. Aucun nouvel enregistrement nécessaire.';



    if(recorded&&!correctionRefreshed){modal.dataset.allowOrderRefresh='true';try{await orders();correctionRefreshed=true;}catch{state.textContent='Correction enregistrée. Actualisation du tableau en attente ; réessayée au prochain contrôle.';}finally{delete modal.dataset.allowOrderRefresh;}}



    if(effectiveAction==='replace-equivalent'&&(recorded||(r.status==='complete'&&r.result?.partialRemainder===true))){const preview=body.querySelector('[data-preview]');if(preview)preview.textContent=r.status==='complete'?'Remplacement enregistré. Vérification terminée.':r.error||['review','failed','cancelled'].includes(r.status)?'Remplacement enregistré. Préparation à vérifier : '+(r.error||r.stage):'Remplacement enregistré. '+(observedStatus==='review'?'Préparation bloquée : '+observedStep:observedStatus==='queued'?'Préparation en attente.':'Contrôle du stock et du BL en cours.')+' Vous pouvez fermer cette fenêtre ; le traitement continue dans V3.';const note=body.querySelector('[data-quantity-note]');if(note)note.textContent=note.textContent.replace('Le changement reste à vérifier et à confirmer.','Remplacement enregistré.');}



    if(r.status==='review'&&effectiveAction==='compare-bc'&&r.result?.readOnly===true&&r.result?.bc){queuedHandle=null;state.textContent=r.error?displayErrorMessage(r.error):r.result.message||'Comparaison à vérifier';return r.result;}
    if(['review','cancelled','failed'].includes(r.status)){queuedHandle=null;review=true;const error=Error(r.error||r.result?.message||(r.status==='cancelled'?'Demande annulée. Vérifiez le résultat métier avant toute nouvelle intervention.':'Résultat à vérifier'));error.correctionRecorded=recorded;if(r.result?.readOnly===true){error.providerDiagnostic=true;error.message=(r.result.message||'Lecture fournisseur partielle.')+' Vérification nécessaire : '+error.message;}else if(recorded)error.message=(r.result.message||'Correction enregistrée.')+' Problème restant : '+error.message;throw error;}



    if(r.status==='complete'){queuedHandle=null;let message=effectiveAction==='equivalent-preview'?(r.result?.reconcileOnly?'Remplacement déjà présent dans Erplain ; synchronisation V3 à confirmer.':'Équivalent vérifié uniquement. Remplacement non enregistré : cochez la confirmation puis cliquez sur « Enregistrer et reprendre la commande ».'):(r.result?.message||'Vérification terminée');if(!['check-sku','compare-bc','equivalent-preview'].includes(effectiveAction)){modal.dataset.allowOrderRefresh='true';try{await orders();}catch(e){message+=' Actualisation du tableau indisponible : '+e.message;}finally{delete modal.dataset.allowOrderRefresh;}if(!closed)finished(ctx,true,message,false,false,r.result?.readOnly===true);}state.textContent=message;return r.result;}



    await new Promise(resolve=>{releasePoll=resolve;pollTimer=setTimeout(resolve,1200);});



   }



  }catch(e){if(!queuedHandle&&pendingRequest&&[400,401,403,404,422].includes(e.status))pendingRequest=null;if(pendingRequest)e.message+=' Le résultat de l’enregistrement est inconnu. Vérifiez la commande ; une nouvelle vérification identique conservera le même identifiant.';if(queuedHandle)e.message+=' La demande est déjà enregistrée ; sa prochaine vérification reprendra le même traitement, sans nouvelle soumission.';if(!closed){state.textContent=displayErrorMessage(e);finished(ctx,false,e.message,review,e.correctionRecorded,e.providerDiagnostic);if(review){modal.dataset.allowOrderRefresh='true';try{await orders();}catch{state.textContent=displayErrorMessage(e)+' Actualisation du tableau indisponible ; utilisez Actualiser la liste.';}finally{delete modal.dataset.allowOrderRefresh;}}else await orders().catch(()=>{});if(!body.querySelector('[data-reopen]')){const next=document.createElement('button');next.dataset.reopen='true';next.textContent='Voir le problème restant';next.onclick=()=>{modal.close();openCorrection(ctx.order.id).catch(e=>flash(e,true));};body.append(next);}}throw e;}finally{clearInterval(timer);if(!closed){if(!clock.textContent.includes('non confirmé'))clock.textContent+=' · durée de consultation : '+Math.floor((Date.now()-start)/1000)+' s';busy(false);}}



 }



 return {modal,body,state,job,get closed(){return closed;}};



}



async function openRemainingProblem(id){



 if(typeof invalidateOrderDetailReads==='function')invalidateOrderDetailReads();const contextRequest={version:++resolutionContextRequestVersion,user,view:currentView};let ctx;try{ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));}catch(error){if(!resolutionContextIsCurrent(contextRequest))return;throw error;}if(!resolutionContextIsCurrent(contextRequest))return;if(ctx.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');if(isDeliveredOrder(ctx.order)){const d=resolutionDialog('Commande livrée',ctx.order.reference);d.body.textContent='Livrée · aucun problème à gérer';return;}



 const problems=resolutionProblems(ctx);



 if(ctx.active)return openCorrection(id);



 if(problems.length===1)return renderResolution(ctx,problems[0]);



 if(problems.length>1)return openCorrection(id);



 return orderDetail(id);



}



async function openOrderReplacement(id){



 if(typeof invalidateOrderDetailReads==='function')invalidateOrderDetailReads();const contextRequest={version:++resolutionContextRequestVersion,user,view:currentView};let ctx;try{ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));}catch(error){if(!resolutionContextIsCurrent(contextRequest))return;throw error;}if(!resolutionContextIsCurrent(contextRequest))return;if(ctx.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');if(isDeliveredOrder(ctx.order)){const d=resolutionDialog('Commande livrée',ctx.order.reference);d.body.textContent='Livrée · aucun problème à gérer';return;}



 if(ctx.active)return openCorrection(id);



 if(ctx.order.erp_live?.bc?.id)return openStockEquivalent(ctx,{type:'stock'});



 const lines=(ctx.lines||[]).filter(l=>l.source_sku&&Number(l.quantity)>0);



 const choices=[...new Map(lines.map(l=>[l.source_sku,l])).values()];



 const open=line=>renderResolution(ctx,{type:'mapping',sku:line.source_sku,equivalent:true});



 if(choices.length===1)return open(choices[0]);



 const d=resolutionDialog('Choisir le produit à remplacer',ctx.order.reference);



 const note=document.createElement('p');note.textContent=choices.length?'Choisissez la ligne à remplacer avant la création du BC. Les autres produits restent inchangés.':'Aucune ligne produit disponible : vérifier les données de la commande.';d.body.append(note);



 for(const line of choices){const b=document.createElement('button');b.type='button';b.textContent=line.source_sku+(line.target_sku||line.mapped_sku?' → '+(line.target_sku||line.mapped_sku):'');b.onclick=()=>{d.modal.close();open(line);};d.body.append(b);}



 return d;



}



async function openCorrection(id,type,sku,detail){



 if(typeof invalidateOrderDetailReads==='function')invalidateOrderDetailReads();const contextRequest={version:++resolutionContextRequestVersion,user,view:currentView};let ctx;try{ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));}catch(error){if(!resolutionContextIsCurrent(contextRequest))return;throw error;}if(!resolutionContextIsCurrent(contextRequest))return;if(ctx.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');if(isDeliveredOrder(ctx.order)){const d=resolutionDialog('Commande livrée',ctx.order.reference);d.body.textContent='Livrée · aucun problème à gérer';return;}const problems=resolutionProblems(ctx);



 if(ctx.active){const d=resolutionDialog('Traitement en cours',ctx.order.reference);d.body.textContent='La commande est déjà en cours de traitement. Aucun second lancement.';try{await d.job(ctx,'resume','resolved');await orders();}catch{}return;}



 const selected=(type&&problems.find(p=>p.type===type&&p.sku===(sku||'')&&(detail===undefined||p.detail===detail)))||(!type&&problems.length===1?problems[0]:null);



 if(!selected){const d=resolutionDialog('Choisir le problème à résoudre',ctx.order.reference);d.body.innerHTML='<p>Chaque bouton ouvre uniquement le problème indiqué.</p><div class="resolution-choices"></div>';



  if(!problems.length){d.body.innerHTML='<p></p>';d.body.firstElementChild.textContent=ctx.order.partial_mode?'Livraison partielle : consultez les livraisons existantes et le reliquat avant toute nouvelle préparation.':ctx.erpJob?.status==='processing'?'Préparation Erplain en cours. Aucun motif de blocage reçu ; attendez son résultat avant de relancer.':ctx.erpJob?.status==='review'||ctx.order.erp_status==='live_review'?'Préparation Erplain à vérifier. Aucun motif détaillé reçu ; consultez le BC, les BL et le traitement avant de relancer.':ctx.order.resolution_pending_resume?'Les corrections sont enregistrées ; la reprise de la préparation reste à demander.':'Aucun problème de préparation restant.';if(ctx.order.partial_mode||ctx.order.erp_status==='live_review'||['processing','review'].includes(ctx.erpJob?.status)){const view=document.createElement('button');view.type='button';view.textContent='Voir la commande et ses livraisons';view.onclick=()=>{d.modal.close();orderDetail(ctx.order.id).catch(e=>flash(e,true));};d.body.append(view);}if(ctx.order.resolution_pending_resume){const b=document.createElement('button');b.textContent='Reprendre la commande';b.onclick=async()=>{try{await d.job(ctx,'resume','resolved');await orders();}catch{}};d.body.append(b);}addImportCorrectionActions(ctx,d);return;}



  const list=problems;



  for(const p of list){const b=document.createElement('button');b.textContent=(p.sku?p.sku+' · ':'')+p.label;b.title=p.detail||p.label;b.onclick=()=>{d.modal.close();renderResolution(ctx,p);};d.body.lastElementChild.append(b);}addImportCorrectionActions(ctx,d);return;



 }



 return renderResolution(ctx,selected);



}



function renderResolution(ctx,problem){



 if(problem.type==='equivalent-pending'&&ctx.order.pending_equivalent)return openStockEquivalent(ctx,{type:'stock',sku:ctx.order.pending_equivalent.sku});



 const spec=problem.type==='mapping'&&problem.equivalent?{title:'Proposer un produit équivalent',view:'mapping'}:resolutionViews[problem.type]||resolutionViews.unknown,d=resolutionDialog((problem.sku?problem.sku+' · ':'')+(spec.view==='unknown'||['weight','preparation','city'].includes(problem.type)?problem.label:spec.title),ctx.order.reference);



 d.body.innerHTML='<p data-scope></p><div data-fields></div><div data-result></div>';
 addImportCorrectionActions(ctx,d);



 const scope=d.body.querySelector('[data-scope]'),fields=d.body.querySelector('[data-fields]'),result=d.body.querySelector('[data-result]');



 const line=ctx.lines.find(l=>l.source_sku===problem.sku||l.target_sku===problem.sku||l.mapped_sku===problem.sku),target=problem.sku||line?.target_sku||line?.mapped_sku||'';



 // Display only source lines matching this problem, never an unrelated product.



 const sourceLines=ctx.lines.filter(l=>problem.sku&&[l.source_sku,l.target_sku,l.mapped_sku].includes(problem.sku));



 if(sourceLines.length){



  const sourceNames={amazon:'Amazon',temu:'TEMU',shopify:'Shopify',tender:'Appels d’offres',samples:'Échantillons',rakuten:'Rakuten'};



  const origin=sourceNames[ctx.order.channel]||'la plateforme';



  for(const sourceLine of sourceLines){



   const description=document.createElement('p');description.className='resolution-source-product';



   const label=document.createElement('strong');label.textContent='Produit sur '+origin+' · '+sourceLine.source_sku+' : ';



   description.append(label,document.createTextNode(sourceProductName(sourceLine)||'Nom du produit non transmis par la plateforme.'));



   scope.before(description);



  }



 }



 const task=(action,data={})=>d.job(ctx,action,problem.type,data);



 function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>Promise.resolve().then(fn).catch(e=>{d.state.textContent=displayErrorMessage(e);});fields.append(b);return b;}



 async function saved(r){await orders();if(d.closed)return;result.replaceChildren();const remaining=(r?.checks||[]).filter(x=>x.problem);



  const p=document.createElement('p');p.textContent=remaining.length?remaining.length+' commande(s) ont encore un autre problème à résoudre.':(r?.message||'Vérification terminée.');result.append(p);



  const next=document.createElement('button');next.textContent='Voir les problèmes restants';next.type='button';next.onclick=()=>{d.modal.close();openCorrection(ctx.order.id).catch(e=>flash(e,true));};result.append(next);



  if(!ctx.order.pending_equivalent&&!r?.resume&&r?.checks?.find(x=>x.id===ctx.order.id&&x.prepared)){const resume=document.createElement('button');resume.type='button';resume.textContent='Reprendre la commande';resume.onclick=async()=>{try{await d.job(ctx,'resume','resolved');await orders();}catch{}};result.append(resume);}



 }



 function checkedProduct(r,container){container.replaceChildren();const p=document.createElement('p');p.textContent=({missing:'SKU absent d’Erplain LIVE.',inactive:'Produit présent mais inactif dans Erplain LIVE.',duplicate:'Plusieurs produits actifs portent ce SKU. Choisissez le produit de référence.',active:'Produit actif trouvé dans Erplain LIVE.'})[r.status]||'Réponse à vérifier';container.append(p);



  const select=document.createElement('select');select.setAttribute('aria-label','Produit Erplain vérifié');



  for(const v of (r.candidates||[]).filter(v=>r.status==='inactive'||v.active!==false&&v.product?.active!==false)){const op=new Option(v.sku+' — '+(v.product?.label||'Produit')+' · ID '+v.id+(v.active===false||v.product?.active===false?' · inactif':''),String(v.id));select.add(op);}



  if(r.status==='duplicate'){const empty=new Option('Choisir le produit de référence','');select.prepend(empty);select.value='';}



  if(r.status==='active'&&r.variant?.id!=null&&Array.from(select.options).some(option=>option.value===String(r.variant.id)))select.value=String(r.variant.id);
  if(select.options.length)container.append(select);
  if(r.selection){const detail=document.createElement('p');const reasons={'highest-usable-stock':'Produit actif retenu au stock disponible le plus élevé','existing-document':'Produit déjà utilisé dans le document Erplain conservé','explicit-binding':'Produit de référence déjà enregistré conservé','unique':'Seul produit actif pour ce SKU'};const stock=typeof r.selection.usableStock==='number'&&Number.isFinite(r.selection.usableStock)?new Intl.NumberFormat('fr-FR').format(r.selection.usableStock)+' unités':'non fourni';detail.textContent=(reasons[r.selection.reason]||'Choix du produit fourni par Erplain')+' · ID '+String(r.selection.variantId||r.variant?.id||'non fourni')+' · Stock disponible : '+stock+(r.selection.locationId?' · Dépôt '+r.selection.locationId:'')+'. La préparation du BC et du BL reste à vérifier.';container.append(detail);}
  return select;



 }



 async function createProduct(sku,back,resumeAfter=true){



  const c=resolutionDialog(sku+' · Créer le produit Erplain',ctx.order.reference);c.body.innerHTML='<p>Produit partagé · Erplain LIVE. Le stock restera à zéro jusqu’à un mouvement réel.</p><form><label>SKU Erplain<input name="sku" readonly value="'+esc(sku)+'"></label><label>Nom du produit<input name="label" required maxlength="250" value="'+esc(sourceProductName(line))+'"></label><label>Poids d’une unité (kg)<input name="weight" type="number" min="0.000001" max="3000" step="any" required></label><button type="submit">Créer dans Erplain LIVE</button></form>';



  c.body.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;try{const r=await c.job(ctx,'create-product','missing',{sku,label:f.elements.label.value,weightKg:Number(f.elements.weight.value),resumeAfter});if(r){c.modal.close();await back(r);}}catch{}};



 }



 if(spec.view==='temu-pricing'){
  const pricingReason=String(problem.detail||'');
  if(pricingReason.trim()){const reason=document.createElement('p');reason.dataset.pricingReason='';reason.style.whiteSpace='pre-wrap';reason.style.overflowWrap='anywhere';reason.textContent=pricingReason;scope.before(reason);}




  if(ctx.order.channel!=='temu'||!['HR','SE'].includes(String(ctx.order.address?.country).toUpperCase())){scope.textContent='Les montants TEMU doivent être récupérés pour cette boutique. La saisie manuelle concerne la Croatie et la Suède.';return;}



  scope.textContent='Saisissez les montants de cette commande dans TEMU. Vérifiez le taux de TVA prérempli avant de valider. Les prix unitaires sont hors taxes ; les frais de livraison sont TTC.';



  if(ctx.order.erp_live?.bc?.id||ctx.order.erp_live?.bl?.id){fields.textContent='Un document Erplain existe déjà. Les prix et quantités ne peuvent plus être modifiés dans cette fenêtre.';return;}



  const data=ctx.order.source_payload?.temuManualPricing?.data||ctx.order.source_payload?.temuAmounts?.data;



  const form=document.createElement('form');fields.append(form);



  form.innerHTML='<label>Devise<select name="currency" required><option value="">Choisir la devise</option><option value="EUR">EUR</option><option value="SEK">SEK</option></select></label><label>TVA (%)<input name="vatRate" type="number" required min="0" max="100" step="0.01" value="25"></label><p>Ce taux s’applique aux produits et aux frais de livraison de cette commande.</p><div data-price-lines></div><p data-price-total role="status"></p><button type="submit">Enregistrer et reprendre la commande</button>';



  form.elements.currency.value=data?.parentOrderMap?.basePriceTotal?.currency||(ctx.order.address?.country==='HR'?'EUR':'');



  form.elements.vatRate.value=ctx.order.source_payload?.temuManualPricing?.vatRate??25;



  const rows=ctx.lines.map(l=>{const a=data?.orderList?.find(x=>String(x.orderSn)===String(l.source_payload?.temuOrderSn||l.source_line)),box=document.createElement('fieldset');box.innerHTML='<legend>'+esc(l.source_sku)+' — '+esc(sourceProductName(l)||'Produit de la commande')+'</legend><p>Quantité actuellement enregistrée : '+esc(l.quantity)+'</p><label>Quantité à commander<input name="quantity" type="number" required min="1" step="1" value="'+esc(l.quantity)+'"></label><label>Prix unitaire HT<input name="unit" type="number" required min="0" step="0.01"></label><label>Frais de livraison TTC pour cette ligne<input name="shipping" type="number" required min="0" step="0.01"></label>';form.querySelector('[data-price-lines]').append(box);



  if(a?.unitBasePrice?.amount!=null)box.querySelector('[name=unit]').value=Number(a.unitBasePrice.amount)/100;



  if(a?.shipAmountTotalTaxIncl?.amount!=null)box.querySelector('[name=shipping]').value=Number(a.shipAmountTotalTaxIncl.amount)/100;



  else if(ctx.order.source_payload?.temuOrderDetail?.parentOrderMap?.hasShippingFee===false)box.querySelector('[name=shipping]').value='0';



  return {id:l.id,box};});



  function values(){return rows.map(({id,box})=>({id,quantity:box.querySelector('[name=quantity]').value,unitPriceHt:box.querySelector('[name=unit]').value,shippingTtc:box.querySelector('[name=shipping]').value}));}



  form.oninput=()=>{const rows=values(),rate=Number(form.elements.vatRate.value),factor=1+rate/100;if(form.elements.vatRate.value===''||!Number.isFinite(rate)||rate<0||rate>100||rows.some(x=>!x.quantity||x.unitPriceHt===''||x.shippingTtc==='')){form.querySelector('[data-price-total]').textContent='Complétez tous les montants pour afficher le total.';return;}let total=0,tax=0;for(const x of rows){const net=Math.round(Number(x.unitPriceHt)*100)*Number(x.quantity),ship=Math.round(Number(x.shippingTtc)*100),vat=Math.round(net*rate/100);total+=net+vat+ship;tax+=vat+Math.round(ship-ship/factor);}form.querySelector('[data-price-total]').textContent='Total TTC : '+(total/100).toFixed(2)+' '+form.elements.currency.value+' · TVA : '+(tax/100).toFixed(2);};form.oninput();



  form.onsubmit=async e=>{e.preventDefault();if(!form.reportValidity())return;try{await saved(await task('manual-temu-pricing',{currency:form.elements.currency.value,vatRate:form.elements.vatRate.value,priceLines:values(),priceFingerprint:ctx.priceFingerprint}));}catch{}};return;



 }



 if(spec.view==='platform'){







  scope.textContent='La préparation reste en pause pour éviter un envoi avec les anciennes données.';



  const pending=ctx.order.source_payload?.marketplacePendingCorrection;



  if(pending&&ctx.order.channel==='shopify'){
    const a=pending.shipping_address||{},name=a.name||[a.first_name,a.last_name].filter(Boolean).join(' '),received={name,street:[a.address1,a.address2].filter(Boolean).join(', '),postal:a.zip||'',city:a.city||'',country:a.country_code||'',phone:a.phone||'',email:pending.contact_email||pending.email||''},current={...(ctx.order.address||{}),name:ctx.order.recipient||ctx.order.address?.name||''};
    const heading=document.createElement('p');heading.textContent='Données de livraison : actuelles / reçues de Shopify';fields.append(heading);
    const table=document.createElement('table');table.style.width='100%';table.style.tableLayout='fixed';
    const header=document.createElement('tr');for(const label of ['Champ','Valeur actuelle','Valeur reçue']){const th=document.createElement('th');th.textContent=label;header.append(th);}table.append(header);
    let changes=0;for(const [key,label] of [['name','Destinataire'],['street','Rue'],['postal','Code postal'],['city','Ville'],['country','Pays'],['phone','Téléphone'],['email','E-mail']]){const old=String(current[key]??''),next=String(received[key]??''),changed=old!==next;changes+=changed?1:0;const row=document.createElement('tr');for(const value of [label+(changed?' · modifié':''),old||'Non renseigné',next||'Non renseigné']){const td=document.createElement('td');td.textContent=value;td.style.overflowWrap='anywhere';td.style.verticalAlign='top';row.append(td);}table.append(row);}fields.append(table);
    const summary=document.createElement('p');summary.textContent=changes?changes+' champ(s) de livraison différent(s).':'Aucune différence dans les données de livraison affichées. Vérifiez aussi les articles et le statut Shopify.';fields.append(summary);
    const status=document.createElement('p'),statuses={fulfilled:'Expédiée',partial:'Partiellement expédiée',partially_fulfilled:'Partiellement expédiée',unfulfilled:'Non expédiée',unshipped:'Non expédiée'};status.textContent='Statut reçu de Shopify : '+(pending.cancelled_at?'Annulée':statuses[pending.fulfillment_status]||pending.fulfillment_status||'Non renseigné');fields.append(status);
  }
  if(pending){const items=ctx.order.channel==='shopify'?pending.line_items:pending.detail?.orderList;const title=document.createElement('p');title.textContent='Articles reçus de la plateforme :';fields.append(title);for(const item of items||[]){const p=document.createElement('p');const sku=item.sku||item.productList?.map(x=>x.extCode).filter(Boolean).join(', ')||'SKU non reçu';const current=ctx.lines.find(l=>l.source_sku===sku);p.textContent=sku+' · quantité actuelle : '+(current?.quantity??'absente')+' · quantité reçue : '+item.quantity; fields.append(p);}}



  const canApply=pending&&!ctx.order.erp_live?.bc?.id&&!ctx.order.erp_live?.bl?.id&&!ctx.job;



  if(canApply)button('Appliquer les nouvelles données',async()=>saved(await task('accept-source-change',{resumeAfter:false})));else{const p=document.createElement('p');p.textContent='Des documents existent. Vérifiez les modifications des articles, quantités et adresse avant toute nouvelle préparation.';fields.append(p);}



  button('Conserver la commande en pause',()=>d.modal.close());return;



 }



 if(spec.view==='mapping'){



  if(!line){d.state.textContent='Ligne SKU introuvable : actualiser la commande.';return;}



  const mappingQuantities=mappingQuantityDefaults(line);



  scope.textContent=problem.equivalent?'Choisissez un produit Erplain existant qui convient en remplacement, les quantités et la portée. Le stock sera contrôlé avant la préparation.':'Choisissez si la correction concerne cette commande uniquement ou le mapping permanent.';



  fields.innerHTML='<form class="resolution-mapping"><label>Appliquer la correction<select name="scope" required><option value="">Choisir la portée</option><option value="order">Uniquement cette commande</option><option value="permanent">Mapping permanent pour ce gestionnaire et ce SKU</option></select></label><label>Gestionnaire<select name="channel">'+[['amazon','Amazon .fr'],['shopify','NEXTECH Boutique / RELAIS'],['temu','TEMU'],['tender','Appels d’offres'],['samples','Échantillons'],['rakuten','RAKUTEN']].map(([v,t])=>'<option value="'+v+'">'+t+'</option>').join('')+'</select></label><label>SKU gestionnaire<input name="source_sku" required value="'+esc(line.source_sku)+'" readonly></label><label>SKU Erplain<input name="target_sku" required value="'+esc(problem.equivalent?'':line.mapped_sku||'')+'" list="resolution-skus"></label><datalist id="resolution-skus">'+ctx.products.map(p=>'<option value="'+esc(p.sku)+'">'+esc(p.label)+'</option>').join('')+'</datalist><button type="button" data-check>Vérifier dans Erplain</button><div data-product-result></div><div class="resolution-quantities"><label>Quantité gestionnaire<input name="source_qty" type="number" min="0.000001" step="any" required value="'+esc(mappingQuantities.source)+'"></label><label>Quantité Erplain<input name="target_qty" type="number" min="0.000001" step="any" required value="'+esc(mappingQuantities.target)+'"></label></div><label>Notes<input name="notes" maxlength="1000" value="'+esc(line.notes||'')+'"></label><p>Quantité Erplain commandée = quantité source × quantité Erplain ÷ quantité gestionnaire.</p><button type="submit">Enregistrer et reprendre la commande</button></form>';



  const form=fields.querySelector('form');form.elements.channel.value=ctx.order.channel;let checked=null,choice=null;



  if(problem.equivalent){



   const label=document.createElement('label');label.style.display='flex';label.style.alignItems='center';label.style.gap='10px';



   const confirm=document.createElement('input');confirm.type='checkbox';confirm.required=true;confirm.style.width='18px';confirm.style.flex='0 0 18px';



   label.append(confirm,document.createTextNode('Je confirme que ce produit convient en remplacement.'));form.querySelector('button[type="submit"]').before(label);



  }else button('Proposer un produit équivalent',()=>{d.modal.close();renderResolution(ctx,{...problem,equivalent:true});});



  async function verify(){const sku=form.elements.target_sku.value.trim();const r=await task('check-sku',{sku});if(!r)return null;checked=r;choice=checkedProduct(r,form.querySelector('[data-product-result]'));



   if(r.status==='missing'){const b=document.createElement('button');b.type='button';b.textContent='Créer ce SKU dans Erplain LIVE';b.onclick=()=>createProduct(sku,verify,false);form.querySelector('[data-product-result]').append(b);}return r;}



  form.querySelector('[data-check]').onclick=()=>verify().catch(()=>{});form.elements.target_sku.oninput=()=>{checked=null;choice=null;form.querySelector('[data-product-result]').replaceChildren();};



  form.onsubmit=async e=>{e.preventDefault();try{if(!checked||checked.sku!==form.elements.target_sku.value.trim())await verify();if(!checked||!['active','duplicate'].includes(checked.status)||!choice?.value)throw Error('Vérifier et choisir un produit Erplain actif avant d’enregistrer');const values=Object.fromEntries(new FormData(form));await saved(await task('mapping',{...values,variantId:choice.value}));}catch(e){d.state.textContent=displayErrorMessage(e);}};



 }else if(spec.view==='weight'){
  if(!target){const candidates=equivalentCandidates(ctx);if(candidates.length===1){d.modal.close();return renderResolution(ctx,{...problem,sku:candidates[0].sku});}fields.replaceChildren();scope.textContent=candidates.length?'Le diagnostic ne précise pas le SKU concerné. Choisissez explicitement le produit Erplain de cette commande avant de renseigner son poids.':'Aucun SKU Erplain résolu pour ce diagnostic. Vérifiez le mapping et la commande avant de renseigner un poids.';for(const candidate of candidates)button(candidate.sku+' · '+candidate.quantity+' unités',()=>{d.modal.close();renderResolution(ctx,{...problem,sku:candidate.sku});});button('Voir la commande et ses livraisons',()=>{d.modal.close();orderDetail(ctx.order.id);});return d;}




  scope.textContent='Poids d’une unité du SKU Erplain · enregistré dans Erplain LIVE et partagé entre commandes.';



  const pending=ctx.order.pending_equivalent;if(pending){scope.textContent+=' Remplacement prévu : '+pending.sku+' → '+pending.replacementSku+'. Après correction du poids, vérifiez et confirmez le remplacement.';}



  fields.innerHTML='<form><label>SKU Erplain<input readonly name="sku" value="'+esc(target)+'"></label><label>Poids unitaire en kg<input name="weight" type="number" min="0.000001" max="3000" step="any" required value="'+esc(line?.weight_kg||'')+'"></label><p>Exemple : 60 g = 0,060 kg. Les quantités et le mapping restent identiques.</p><button type="submit">Enregistrer et reprendre la commande</button></form>';



  if(problem.detail){const recorded=document.createElement('p');recorded.className='resolution-diagnostic';recorded.textContent=problem.detail;fields.append(recorded);}
  const recordedWeight=Number(line?.source_payload?.erplainCorrectedWeightKg);
  if(Number.isFinite(recordedWeight)&&recordedWeight>0&&Number(line?.weight_kg)===recordedWeight){const explanation=document.createElement('p');explanation.className='resolution-diagnostic';explanation.textContent='Une correction de poids est enregistrée pour ce SKU ('+String(recordedWeight).replace('.',',')+' kg). Le motif reçu reste à rapprocher avec la préparation actuelle avant toute reprise.';fields.append(explanation);}
  if(pending){fields.querySelector('button[type="submit"]').textContent='Enregistrer le poids';button('Reprendre le remplacement',()=>{d.modal.close();openStockEquivalent(ctx,{type:'stock',sku:pending.sku});});}

  fields.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await saved(await task('weight',{sku:target,weightKg:Number(e.currentTarget.elements.weight.value),...(pending?{resumeAfter:false}:{}),...(line?.live_variant_id?{variantId:line.live_variant_id}:{})}));}catch{}};



 }else if(spec.view==='product'){



  scope.textContent='Référence produit partagée · Erplain LIVE. Le mapping existant est conservé.';



  fields.innerHTML='<p>SKU Erplain : <strong>'+esc(target)+'</strong></p><div data-found></div>';const box=fields.querySelector('[data-found]');



  async function verify(){const r=await task('check-sku',{sku:target});if(!r)return;fields.querySelector('[data-product-action]')?.remove();const choice=checkedProduct(r,box);let action;



   if(r.status==='missing')action=button('Créer ce produit dans Erplain LIVE',()=>createProduct(target,()=>{d.modal.close();openCorrection(ctx.order.id);}));



   else if(r.status==='inactive')action=button('Réactiver le produit et reprendre la commande',async()=>saved(await d.job(ctx,'activate-product','inactive',{sku:target,variantId:choice.value})));



   else action=button(r.status==='duplicate'?'Enregistrer et reprendre la commande':'Actualiser et reprendre la commande',async()=>{if(!choice.value){d.state.textContent='Choisissez le produit Erplain de référence avant d’enregistrer.';return;}await saved(await d.job(ctx,'select-product','duplicate',{sku:target,variantId:choice.value}));});



   action.dataset.productAction='true';



  }



  button('Vérifier le SKU dans Erplain',verify);



  if(problem.type==='missing'){



   const create=button('Créer ce SKU dans Erplain LIVE',()=>createProduct(target,async()=>{d.modal.close();await orders();await openCorrection(ctx.order.id);}));



   create.dataset.productAction='true';



  }



  if(['missing','inactive'].includes(problem.type)&&line)button('Proposer un produit équivalent',()=>{d.modal.close();renderResolution(ctx,{...problem,type:'mapping',sku:line.source_sku,equivalent:true});});



  if(problem.type==='missing')button('Corriger le mapping',()=>{if(!line)throw Error('Ligne source absente');d.modal.close();renderResolution(ctx,{...problem,type:'mapping',sku:line.source_sku});});



 }else if(spec.view==='address'){



  scope.textContent='Correction limitée à cette commande et à l’adresse de ses BC/BL Erplain LIVE existants.';



  fields.innerHTML='<form>'+[['name','Destinataire'],['street','Adresse'],['postal','Code postal'],['city','Ville'],['country','Pays ISO'],['phone','Téléphone'],['email','Email']].map(([k,t])=>'<label>'+t+'<input name="'+k+'" value="'+esc(ctx.order.address?.[k]||'')+'" '+(!['phone','email'].includes(k)?'required':'')+'></label>').join('')+'<button type="submit">Enregistrer et reprendre la commande</button></form>';



  fields.querySelector('form').onsubmit=async e=>{e.preventDefault();const address=Object.fromEntries(new FormData(e.currentTarget));address.country=address.country.trim().toUpperCase();try{await saved(await task('address',{address}));}catch{}};



 }else if(spec.view==='routing'){



  scope.textContent='Choisissez un transporteur pour cette commande, ou configurez une règle partagée pour les prochaines commandes. Le stock, le poids et l’adresse sont contrôlés avant création.';



  fields.innerHTML='<p>Service reçu : '+esc((ctx.order.source_payload?.shipping_lines||[]).map(x=>x.title||x.code).join(', ')||ctx.order.channel)+'</p>';



  if(ctx.order.channel!=='temu'){button('Créer étiquette GLS',async()=>saved(await task('choose-carrier',{carrier:'gls'})));button('Créer étiquette GOFO',async()=>saved(await task('choose-carrier',{carrier:'gofo'})));}



  button('Configurer la règle',async()=>{d.modal.close();await show('routing');});button('Vérifier la règle et reprendre la commande',async()=>saved(await task('refresh')));



 }else if(spec.view==='relay'){



  scope.textContent='Point relais propre à cette commande. Le choix du client est conservé ; sinon GLS fournit le relais le plus proche.';



  button('Rechercher le relais et reprendre la commande',async()=>saved(await task('relay')));button('Corriger l’adresse de recherche',()=>{d.modal.close();renderResolution(ctx,{type:'address',sku:'',label:'Adresse de livraison'});});



 }else if(spec.view==='stock'||spec.view==='bc'||spec.view==='historical'||spec.view==='erp-recovery'){



  scope.textContent=spec.view==='erp-recovery'?'Relire le BC et son BL dans Erplain, vérifier le stock, puis reprendre la préparation. Un BL absent est recréé uniquement après vérification de l’absence de mouvement de stock.':spec.view==='historical'?'Rapprocher le BC, le débit de stock déjà effectué et le mapping courant, puis créer le BL manquant. L’étiquette et le suivi existants sont conservés. Le statut de la plateforme reste indicatif.':spec.view==='stock'?'Disponibilité lue dans Erplain LIVE. Une rupture se traite par un produit équivalent, un approvisionnement ou une livraison partielle.':'Comparer la commande au BC et à ses BL. Une livraison partielle ne doit pas être comparée à la totalité du BC.';



  if(problem.detail){const diagnostic=document.createElement('p');diagnostic.className='resolution-diagnostic';diagnostic.textContent=problem.detail;fields.append(diagnostic);}



  button(spec.view==='stock'?'Lire les quantités disponibles dans Erplain':'Comparer le BC et ses livraisons',async()=>{const r=await task('compare-bc');if(!r)return;result.innerHTML='<table><thead><tr><th>SKU</th><th>Commandé BC</th><th>Disponible</th></tr></thead><tbody>'+r.bc.line_items.map(l=>'<tr><td>'+esc((l.variant?.sku||(l.type==='shipping_cost'?'Frais de livraison':l.type)||'Ligne sans produit'))+'</td><td>'+esc(l.quantity)+'</td><td>'+esc(l.available??'Non reçu')+'</td></tr>').join('')+'</tbody></table><p>'+esc((r.bc.shipping_orders?.data||[]).map(bl=>bl.label+' : '+bl.line_items.map(l=>(l.variant?.sku||(l.type==='shipping_cost'?'Frais de livraison':l.type)||'Ligne sans produit')+' ('+l.quantity+')').join(', ')).join(' · ')||'Aucun BL')+'</p>'+((r.errors||[]).map(w=>'<p>'+esc(w?.message??String(w??'Avertissement sans détail'))+'</p>').join(''));});



  if(problem.type==='stock')button('Remplacer par un produit équivalent',()=>{d.modal.close();openStockEquivalent(ctx,problem);});



  if(spec.view==='stock'||spec.view==='historical'||spec.view==='erp-recovery')button(spec.view==='erp-recovery'?'Vérifier Erplain et reprendre le BL':spec.view==='historical'?'Reprendre le BL — étiquette conservée':'Recontrôler le stock et reprendre le BL',async()=>saved(await task('resume-erp')));



  if(problem.type==='stock'&&ctx.order.channel!=='temu'&&!ctx.order.partial_mode&&ctx.job?.status!=='ready'){const note=document.createElement('p');note.textContent='Dérogation : crée le BC dans Erplain LIVE s’il manque, puis l’étiquette PROD. Aucun BL créé ou validé, aucun mouvement de stock. La commande reste en attente de stock. Un BL déjà existant reste inchangé.';fields.append(note);button('Forcer l’étiquette malgré le stock insuffisant',async()=>saved(await task('force-stock-label')));}



  if(spec.view==='bc')button('Recontrôler le BC et reprendre la commande',async()=>saved(await task('refresh')));



  button('Préparer une livraison partielle',()=>{d.modal.close();openPartial(ctx.order.id);});if(spec.view==='bc')button('Ouvrir le BC et les équivalents',()=>{d.modal.close();orderDetail(ctx.order.id);});



 }else if(spec.view==='erp-review'){
  scope.textContent='Préparation Erplain à vérifier : consulter les documents et le traitement avant toute reprise.';
  fields.innerHTML='<p class="resolution-diagnostic">'+esc(problem.detail)+'</p>';
  button('Voir la commande et ses livraisons',()=>{d.modal.close();orderDetail(ctx.order.id);});
 }else if(spec.view==='preparation'){



  scope.textContent='Recontrôler le stock et les BC/BL existants avant de reprendre l’étiquette. Les documents existants sont conservés.';



  fields.innerHTML='<p class="resolution-diagnostic">'+esc(problem.detail)+'</p>';



  button('Actualiser et reprendre la commande',async()=>saved(await task('refresh')));



 }else if(spec.view==='pdf'||spec.view==='uncertain'){



  scope.textContent='Vérifier la création existante avant toute reprise. Cette fenêtre ne crée pas une nouvelle expédition.';



  fields.innerHTML='<p>Transporteur : '+esc(ctx.order.carrier||'À déterminer')+' · Suivi : '+esc(ctx.job?.tracking?.join(', ')||'Non reçu')+'</p>';



  button('Récupérer le PDF de la création existante',async()=>saved(await task('recover-pdf')));button('Ouvrir le suivi et l’historique',()=>{d.modal.close();orderDetail(ctx.order.id);});



 }else{



  const provider=problem.provider||(/GOFO/i.test(problem.label+' '+problem.detail)?'GOFO':/GLS/i.test(problem.label+' '+problem.detail)?'GLS':/Shopify/i.test(problem.label+' '+problem.detail)?'Shopify':/TEMU/i.test(problem.label+' '+problem.detail)?'TEMU':'Erplain');



  const sharedParcelNotice=sharedParcelResolutionNotice(problem,ctx.order),temuLabelNotice=temuLabelResolutionNotice(problem,ctx.order);
  scope.textContent=temuLabelNotice|| (sharedParcelNotice?sharedParcelNotice.description:spec.view==='api'?'Incident de connexion '+provider+' · les données métier ne doivent pas être modifiées pour masquer une erreur API.':'Motif enregistré par V3 ou renvoyé par le service. Le détail complet est affiché ci-dessous ; une actualisation ne garantit pas sa résolution.');



  fields.innerHTML='<p class="resolution-diagnostic">'+esc(problem.detail||'Le motif détaillé n’a pas été enregistré.')+'</p>'+temuRefusalDetailsHtml(problem,ctx);
  if(problem.type==='customer'){
   const number=ctx.order.channel==='temu'&&ctx.order.erp_live?.customerNumber||'V3:'+ctx.order.id;
   fields.innerHTML+='<p>Numéro client à rechercher dans Erplain : <strong>'+esc(number)+'</strong></p><p>Actualiser recherche le client existant. Si vous avez vérifié son absence dans Erplain, vous pouvez autoriser une nouvelle tentative. Une création précédente peut avoir abouti sans réponse : vérifiez avant de confirmer.</p>';
   if(['temu','amazon'].includes(ctx.order.channel)){
    const label=document.createElement('label'),confirmation=document.createElement('input');confirmation.type='checkbox';
    label.append(confirmation,document.createTextNode(' J’ai vérifié dans Erplain que ce client est absent et j’autorise une nouvelle création.'));fields.append(label);
    const retry=button('Autoriser la création du client et reprendre',async()=>{
     if(!confirmation.checked)throw Error('Vérifiez le client dans Erplain et cochez la confirmation.');
     await saved(await task('refresh',{provider:'Erplain',confirmCustomerAbsent:true,customerNumber:number,resumeAfter:true}));
    });retry.disabled=true;confirmation.onchange=()=>{retry.disabled=!confirmation.checked;};
   }
  }



  button(sharedParcelNotice?sharedParcelNotice.button:['TEMU','GLS','GOFO'].includes(provider)?'Actualiser les informations '+provider:'Actualiser et reprendre la commande',async()=>saved(await task('refresh',{...(target?{sku:target}:{}),provider,...(['TEMU','GLS','GOFO'].includes(provider)?{resumeAfter:false}:{})})));if(temuLabelNotice)button('Enregistrer une étiquette externe déjà achetée',()=>{d.modal.close();openExternalLabel(ctx.order.id);});else button('Ouvrir les connexions',()=>{d.modal.close();show('connections');});



 }



 if(ctx.active){const p=document.createElement('p');p.textContent='Intervention enregistrée à l’ouverture : '+(ctx.active.stage||'Étape non transmise.');d.body.prepend(p);}



 return d;



}







function equivalentCandidates(ctx){



 const groups=new Map();



 for(const line of ctx.lines||[]){



  const resolved=Object.hasOwn(line,'replacement_sku');
  const sku=String((resolved?line.replacement_sku:line.target_sku||line.mapped_sku||(['tender','samples'].includes(ctx.order.channel)?line.source_sku:''))||'').trim();if(!sku)continue;



  const quantity=Number(resolved?line.replacement_quantity:line.target_quantity??(Number(line.source_qty)>0?Number(line.quantity)*Number(line.target_qty)/Number(line.source_qty):line.quantity));



  if(!Number.isFinite(quantity)||quantity<=0)continue;



  const candidate=groups.get(sku)||{sku,quantity:0,sources:[]};candidate.quantity+=quantity;candidate.sources.push(String(line.source_sku||'').trim());groups.set(sku,candidate);



 }



 if(ctx.order.partial_mode){

  const allocations=ctx.order.partial_allocation;if(!Array.isArray(allocations))return [];

  return [...groups.values()].flatMap(c=>{const a=allocations.filter(a=>a.sku===c.sku);if(a.length!==1||!Number.isFinite(Number(a[0].remaining))||Number(a[0].remaining)<=0)return [];return [{...c,quantity:Number(a[0].remaining),allocated:Number(a[0].allocated)||0}];});

 }

 return [...groups.values()];



}



function equivalentSelection(ctx,problem){



 const candidates=equivalentCandidates(ctx),requested=String(problem?.sku||'').trim(),pending=ctx.order.pending_equivalent;



 const wanted=pending&&requested===pending.replacementSku?String(pending.sku):requested;



 const exact=wanted?candidates.filter(c=>c.sku===wanted):[];



 const matched=exact.length?exact:wanted?candidates.filter(c=>c.sources.includes(wanted)):[];



 return {candidates,selected:matched.length===1?matched[0]:!wanted&&candidates.length===1?candidates[0]:null};



}



function openStockEquivalent(ctx,problem){



 const {candidates,selected}=equivalentSelection(ctx,problem);



 const d=resolutionDialog('Remplacer par un produit équivalent',ctx.order.reference);



 if(!selected){



  const note=document.createElement('p');note.textContent=candidates.length?'Choisissez le produit de cette commande à remplacer.':'Aucun SKU Erplain résolu : corrigez d’abord le mapping du produit.';d.body.append(note);



  for(const candidate of candidates){const button=document.createElement('button');button.type='button';button.textContent=candidate.sku+' · '+candidate.quantity+' unités';button.onclick=()=>{d.modal.close();openStockEquivalent(ctx,{...problem,sku:candidate.sku});};d.body.append(button);}



  return d;



 }



 const sku=selected.sku,erplainQuantity=selected.quantity,partialRemainder=!!ctx.order.partial_mode;



 d.body.innerHTML='<p>Choisissez la portée du remplacement. Une équivalence permanente met à jour le mapping pour les prochaines commandes de ce gestionnaire.</p><form><fieldset style="display:flex;flex-direction:column;gap:12px"><legend>Choisir l’équivalent et lancer le remplacement</legend><label style="display:flex;flex-direction:row;gap:10px;align-items:center"><input type="radio" name="scope" value="order" required style="width:18px;min-width:18px">Équivalence juste pour cette commande</label><label style="display:flex;flex-direction:row;gap:10px;align-items:center"><input type="radio" name="scope" value="permanent" required style="width:18px;min-width:18px">Équivalence permanente</label></fieldset><label>SKU Erplain en rupture<input name="original" readonly value="'+esc(sku)+'"></label><label>SKU Erplain équivalent<input name="replacementSku" required maxlength="199" list="equivalent-skus"></label><datalist id="equivalent-skus">'+(ctx.products||[]).map(p=>'<option value="'+esc(p.sku)+'">'+esc(p.label||p.sku)+'</option>').join('')+'</datalist><label>Étendue du remplacement<select name="replacementMode"><option value="full">Remplacer entièrement ce produit</option><option value="partial">Remplacer partiellement ce produit</option></select></label><div class="resolution-quantities"><label>Quantité du SKU original à remplacer<input name="replaceQuantity" type="number" min="0.000001" step="any" required value="'+esc(erplainQuantity)+'"></label><label>Quantité du produit équivalent à envoyer<input name="replacementQuantity" type="number" min="0.000001" step="any" required value="'+esc(erplainQuantity)+'"></label></div><p data-quantity-note></p><p>Les quantités sont en unités Erplain. Pour un remplacement partiel, saisissez uniquement la quantité à remplacer.</p><p>En lançant le remplacement, vous validez ce produit et ces quantités. V3 vérifie le stock, enregistre le remplacement et poursuit la préparation autorisée automatiquement.</p><div data-preview role="status" aria-live="polite" style="margin:16px 0;padding:12px;border:2px solid #b7791f;border-radius:8px">Choisissez le produit et les quantités, puis lancez le remplacement.</div><button type="submit" data-apply>Remplacer et poursuivre la commande</button></form>';



 const form=d.body.querySelector('form'),apply=form.querySelector('[data-apply]'),preview=form.querySelector('[data-preview]');let busy=false,done=false;
 const initialValues=()=>JSON.stringify({sku:form.elements.replacementSku.value,quantity:form.elements.replacementQuantity.value,originalQuantity:form.elements.replaceQuantity.value,mode:form.elements.replacementMode.value,scope:form.elements.scope.value});let originalValues;



 const pending=ctx.order.pending_equivalent;
 if(pending?.previewJobId){const abandon=document.createElement('button');abandon.type='button';abandon.dataset.abandonEquivalent='true';abandon.textContent='Abandonner l’équivalent';abandon.onclick=async()=>{abandon.disabled=true;try{const result=await d.job(ctx,'abandon-equivalent','stock',{previewJobId:pending.previewJobId});if(result?.abandoned){d.modal.close();await orders();await openCorrection(ctx.order.id);}}catch{}finally{abandon.disabled=false;}};d.body.prepend(abandon);}
 if(pending?.sku===sku){form.elements.scope.value=pending.scope;form.elements.replacementSku.value=pending.replacementSku;form.elements.replaceQuantity.value=pending.replaceQuantity;form.elements.replacementQuantity.value=pending.replacementQuantity;}



 if(partialRemainder){

  form.elements.scope.value='order';form.querySelector('[name="scope"][value="permanent"]').disabled=true;

  form.elements.replacementMode.querySelector('[value="full"]').textContent='Remplacer tout le reliquat de ce produit';

  const note=document.createElement('p');note.textContent='Livraison partielle : '+(selected.allocated||0)+' unités déjà allouées sont conservées. Seul le reliquat de '+erplainQuantity+' unités peut être remplacé. Les BL, étiquettes et suivis existants restent inchangés.';d.body.prepend(note);

  if(pending?.sku===sku&&Number(pending.replaceQuantity)>Number(erplainQuantity)){form.elements.replaceQuantity.value=erplainQuantity;form.elements.replacementQuantity.value=erplainQuantity;}

 }

 form.elements.replacementMode.value=pending?.sku===sku&&Number(pending.replaceQuantity)<Number(erplainQuantity)?'partial':'full';



 form.elements.replacementQuantity.readOnly=false;window.mountEquivalenceSuggestions?.(form,sku);



 const quantityNote=form.querySelector('[data-quantity-note]');const updateQuantityNote=()=>{const full=form.elements.replacementMode.value==='full';form.elements.replaceQuantity.readOnly=full;form.elements.replaceQuantity.max=erplainQuantity;if(full)form.elements.replaceQuantity.value=erplainQuantity;const remaining=Number(erplainQuantity)-Number(form.elements.replaceQuantity.value);quantityNote.textContent=partialRemainder?(full?'Remplacement de tout le reliquat : ':'Remplacement partiel du reliquat : ')+form.elements.replaceQuantity.value+' unités de '+sku+' remplacées par '+form.elements.replacementQuantity.value+' unités de '+(form.elements.replacementSku.value.trim()||'produit équivalent')+'. '+(remaining>0?remaining+' unités de '+sku+' restent à allouer':remaining===0?'Aucune autre unité de '+sku+' ne reste à allouer':'Quantité à remplacer trop élevée')+'. Les '+(selected.allocated||0)+' unités déjà allouées, leurs BL et leurs étiquettes sont conservés. La vérification et l’enregistrement seront effectués ensemble.':(full?'Remplacement complet : ':'Remplacement partiel : ')+form.elements.replaceQuantity.value+' unités de '+sku+' retirées · '+form.elements.replacementQuantity.value+' unités de '+(form.elements.replacementSku.value.trim()||'produit équivalent')+' à envoyer · '+(remaining>0?remaining+' unités de '+sku+' conservées':remaining===0?'aucune unité de '+sku+' conservée':'quantité à remplacer trop élevée')+'. La vérification et l’enregistrement seront effectués ensemble.';};updateQuantityNote();if(partialRemainder)apply.textContent='Remplacer le reliquat et poursuivre';



 originalValues=initialValues();
 const values=()=>({scope:form.elements.scope.value,sku,replacementSku:form.elements.replacementSku.value.trim(),replaceQuantity:Number(form.elements.replaceQuantity.value),replacementQuantity:Number(form.elements.replacementQuantity.value)});



 const enabled=()=>{const abandon=d.body.querySelector('[data-abandon-equivalent]');if(abandon){abandon.disabled=busy||done;abandon.hidden=done;}if(done||d.modal.dataset.equivalentSubmitted)delete d.modal.dataset.unsavedEquivalent;else if(!busy&&!d.modal.dataset.unsavedEquivalent?.includes('tentée')&&initialValues()!==originalValues)d.modal.dataset.unsavedEquivalent='Le remplacement n’est pas lancé. Fermer sans enregistrer ?';apply.disabled=busy||done;apply.textContent=busy?'Vérification et remplacement en cours…':partialRemainder?'Remplacer le reliquat et poursuivre':'Remplacer et poursuivre la commande';};
 const showError=e=>{preview.setAttribute('role','alert');preview.textContent=(e.correctionRecorded?'Remplacement enregistré. ':e.saveAttempted?'Résultat de l’enregistrement à vérifier avant de relancer : ':'Remplacement non enregistré : ')+displayErrorDetail(e)+(e.message.includes('Poids non renseigné')?' · Renseignez le poids du produit '+(/Produit restant \[([^\]]+)\]/.exec(e.message)?.[1]||values().replacementSku)+' dans Erplain, puis réessayez.':'');};



 form.addEventListener('input',()=>{updateQuantityNote();if(!busy&&!done)preview.textContent='Choix modifié. La vérification sera effectuée lors du remplacement.';enabled();});
 form.onsubmit=async e=>{
  e.preventDefault();if(busy||done||!form.reportValidity())return;
  const data=values();busy=true;enabled();
  try{
   d.modal.dataset.unsavedEquivalent='Demande de remplacement en cours. Fermer laisse le traitement continuer ; vérifiez son résultat avant toute nouvelle demande. Fermer le suivi ?';
   preview.setAttribute('role','status');preview.textContent='Vérification du produit et du stock, puis enregistrement du remplacement…';
   const r=await d.job(ctx,'replace-equivalent','stock',{...data,verifyAndApply:true,confirmEquivalent:true});
   if(r){done=true;preview.textContent=r.message;await orders();}
  }catch(error){error.saveAttempted=true;if(error.correctionRecorded)done=true;else d.modal.dataset.unsavedEquivalent='Une demande de remplacement a été tentée. Son résultat reste à vérifier ; ne la relancez pas sans rapprochement. Fermer et consulter l’état de la commande ?';showError(error);}
  finally{busy=false;enabled();if(done)form.querySelectorAll('input,button,select').forEach(x=>x.disabled=true);}
 };

 return d;



}







// Per-order override; shared routing rules remain unchanged.



document.addEventListener('click',event=>{const b=event.target.closest?.('[data-choose-carrier]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();openCarrierChoice(b.dataset.chooseCarrier).catch(e=>flash(e,true));},true);



async function openCarrierChoice(id){



 if(typeof invalidateOrderDetailReads==='function')invalidateOrderDetailReads();const contextRequest={version:++resolutionContextRequestVersion,user,view:currentView};let ctx;try{ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));}catch(error){if(!resolutionContextIsCurrent(contextRequest))return;throw error;}if(!resolutionContextIsCurrent(contextRequest))return;if(ctx.order?.id!==id)throw new Error('La réponse ne correspond pas à la commande demandée.');if(isDeliveredOrder(ctx.order)){const d=resolutionDialog('Commande livrée',ctx.order.reference);d.body.textContent='Livrée · aucun problème à gérer';return;}




 const d=resolutionDialog('Choisir un autre transporteur',ctx.order.reference);



 const existing=ctx.job?.status==='ready'||!!ctx.temuJob?.attempt_id||!!ctx.temuJob?.packages?.length;



 d.body.innerHTML=(ctx.order.channel==='temu'?'<p>TEMU reste le parcours automatique. Ce choix manuel concerne uniquement cette commande.</p>':'')+'<p>Choix pour cette commande uniquement. Les règles partagées restent inchangées. Les contrôles de poids, de stock et de livraison restent nécessaires.</p><form>'+(existing?'<label>La nouvelle étiquette sera<select name="mode" required><option value="">Choisir…</option><option value="add">En plus de l’ancienne</option><option value="replace">À la place de l’ancienne</option></select></label>':'')+'<label>Transporteur<select name="carrier" required><option value="gls">GLS</option><option value="gofo">GOFO</option></select></label><p>Une nouvelle création peut être facturée. L’ancienne étiquette reste conservée ; aucune annulation ni aucun remboursement automatique chez le transporteur ou TEMU.</p><p data-mode-note></p><label style="display:flex;gap:8px;align-items:center"><input style="width:18px;min-width:18px;flex:none" type="checkbox" name="confirmed" required> Je confirme la création de cette nouvelle étiquette.</label><button type="submit">Créer la nouvelle étiquette</button><p role="status" data-feedback></p></form>';



 const form=d.body.querySelector('form');



 if(String(ctx.order.address?.country).trim().toUpperCase()!=='FR'){form.elements.carrier.querySelector('[value="gofo"]').disabled=true;}



 form.elements.mode?.addEventListener('change',()=>{form.elements.confirmed.checked=false;form.querySelector('[data-mode-note]').textContent=form.elements.mode.value==='replace'?'Après création, réimprimez la nouvelle étiquette et retirez l’ancienne du colis.':'Les deux étiquettes seront conservées pour imprimer les colis concernés.';});



 let busy=false;const requestId=crypto.randomUUID();



 form.onsubmit=async e=>{e.preventDefault();if(busy||!form.reportValidity())return;busy=true;const button=form.querySelector('button[type="submit"]');button.disabled=true;try{



  if(form.elements.mode?.value==='add'){



   await api('/api/parcels/add',{id,requestId,count:1,carrier:form.elements.carrier.value});



   form.querySelector('[data-feedback]').textContent='Étiquette supplémentaire demandée. Sa progression et son PDF apparaîtront sur la commande.';



  }else await d.job(ctx,'choose-carrier','routing',{carrier:form.elements.carrier.value,confirmReplace:existing&&form.elements.confirmed.checked});



  await orders();



 }catch(e){form.querySelector('[data-feedback]').textContent=displayErrorMessage(e);busy=false;button.disabled=false;}};



}




document.addEventListener('click',event=>{const button=event.target.closest('[data-external-label]');if(button)openExternalLabel(button.dataset.externalLabel);});
async function openExternalLabel(id){
 const request=++resolutionContextRequestVersion;
 try{
  const ctx=await api('/api/resolutions/context?id='+encodeURIComponent(id));if(request!==resolutionContextRequestVersion)return;
  const saved=ctx.order.source_payload?.externalLabel;
  const d=resolutionDialog('Étiquette externe',ctx.order.reference);
  d.body.innerHTML=saved?.active?'<p>Étiquette externe enregistrée chez '+esc(saved.carrier)+'.</p><p>'+saved.tracking.map(esc).join('<br>')+'</p><p>Le suivi reste assuré via TEMU. Les anciens refus d’étiquette sont conservés dans l’historique.</p>':`<form data-external-label-form><p>Enregistrez les étiquettes déjà achetées à l’extérieur. Aucun achat ne sera lancé par V3. Renseignez également ces suivis dans TEMU ; V3 n’exige aucune validation supplémentaire.</p><label>Transporteur<input name="carrier" required maxlength="80" placeholder="FedEx"></label><label>Numéros de suivi — un par ligne<textarea name="tracking" required rows="3"></textarea></label><label>Étiquette PDF (facultatif, 10 Mo maximum)<input name="pdf" type="file" accept="application/pdf"></label><label><input name="confirmed" type="checkbox" required> Je confirme avoir acheté les étiquettes externes couvrant tous les colis de cette commande.</label><p>Les refus du parcours d’achat TEMU seront classés dans l’historique. Les autres problèmes restent visibles. Le suivi reprendra via TEMU.</p><button type="submit">Enregistrer l’étiquette externe</button><p data-feedback role="status"></p></form>`;
  const form=d.body.querySelector('form');if(!form)return;
  let busy=false;form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;const button=form.querySelector('button');button.disabled=true;try{
   let pdf=null;const file=form.elements.pdf.files[0];if(file){if(file.size>10*1024*1024)throw Error('PDF trop volumineux (maximum 10 Mo)');pdf=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Lecture du PDF impossible'));reader.readAsDataURL(file);});}
   const result=await api('/api/temu/external-label',{id,carrier:form.elements.carrier.value,tracking:form.elements.tracking.value,confirmed:form.elements.confirmed.checked,pdf});form.querySelector('[data-feedback]').textContent=result.message||'Étiquette déjà enregistrée';await orders();
  }catch(e){form.querySelector('[data-feedback]').textContent=displayErrorMessage(e);busy=false;button.disabled=false;}};
 }catch(e){alert(displayErrorMessage(e));}
}

// A BL is sufficient for this explicit label action; preparation diagnostics remain visible.
function addDirectBlLabelButtons(){
 for(const row of document.querySelectorAll('#order-rows tr')){
  const refresh=row.querySelector('[data-erplain-document-kind="bl"]');
  const status=refresh?.parentElement.querySelector('.erp-status');
  if(!refresh||!status||['unknown','cancelled'].includes(status.dataset.status)||row.querySelector('[data-direct-bl-label]')||row.querySelector('[data-temu-order],[data-prepare-partial],.pdf-link')||row.classList.contains('order-cancelled'))continue;
  const resume=row.querySelector('[data-resume-order]');if(!resume)continue;
  const b=document.createElement('button');b.type='button';b.className='badge';b.dataset.directBlLabel=refresh.dataset.erplainDocumentRefresh;b.textContent='Générer l’étiquette';resume.before(b);
 }
}
new MutationObserver(addDirectBlLabelButtons).observe(document.getElementById('order-rows'),{childList:true});
addDirectBlLabelButtons();
document.addEventListener('click',async event=>{const b=event.target.closest?.('[data-direct-bl-label]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();if(b.disabled)return;b.disabled=true;try{const r=await api('/api/carriers/from-bl',{id:b.dataset.directBlLabel});flash(r.status==='ready'?'Étiquette déjà disponible':'Génération de l’étiquette lancée');await orders();}catch(e){flash(e,true);b.disabled=false;}},true);
