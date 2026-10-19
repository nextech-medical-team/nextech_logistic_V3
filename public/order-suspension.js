(()=>{
 const status=$('status');status.add(new Option('Suspendues · attente d’annulation client','__suspended'));
 const filter=document.createElement('button');filter.type='button';filter.textContent='Commandes suspendues';filter.id='suspended-orders-filter';$('all-problems').after(filter);
 filter.onclick=()=>{resetFilters();if($('problem-type'))$('problem-type').selectedIndex=-1;status.value='__suspended';compactFilters.forEach(x=>x.sync());page=1;show('orders');};
 const dialog=document.createElement('dialog');dialog.className='order-suspension-dialog';dialog.setAttribute('aria-labelledby','suspension-title');document.body.append(dialog);
 let context=null,busy=false,opening=false,uncertain=false,localReadPending=false,pendingLocalActive=null,readGeneration=0;
 const date=value=>value?new Date(value).toLocaleString('fr-FR'):'';
 function feedback(message,error=false){const box=dialog.querySelector('[data-suspension-message]');box.textContent=message;box.setAttribute('role',error?'alert':'status');box.hidden=!message;if(message)box.scrollIntoView({block:'nearest'});}
 function render(message='',error=false,note=''){
  const o=context.order,s=o.suspension||{},active=s.active===true,cancel=s.erplainCancellation,pending=uncertain||['processing','review'].includes(cancel?.status),shipped=['shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)||['shipped','delivered'].includes(o.erp_live?.bl?.status);
  dialog.innerHTML='<header><h2 id="suspension-title">'+esc(o.reference)+'</h2><button type="button" data-close-suspension>Fermer</button></header>'+
   '<p><strong>'+(active?(shipped?'Commande suspendue dans V3 · expédition conservée':'Commande suspendue · attente d’annulation client'):'Suspendre la commande')+'</strong></p>'+
   '<p>La suspension bloque les préparations et achats dans V3. La commande reste accessible par recherche et dans « Commandes suspendues ».</p>'+
   (s.note?'<p><strong>Dernière note :</strong> '+esc(s.note)+'<br><small>'+esc(date(s.updatedAt))+' · '+esc(s.updatedBy)+'</small></p>':'')+
   '<section class="suspension-erplain"><h3>Documents ERPLAIN</h3><p>BC : <strong>'+esc(o.erp_live?.bc?.label||'Aucun BC associé')+'</strong></p><p>'+
   esc(cancel?.status==='complete'?'Annulation ERPLAIN confirmée.':pending?'Résultat à vérifier dans ERPLAIN. Ne pas relancer l’annulation.':'Aucune annulation ERPLAIN confirmée.')+'</p>'+
   (cancel?.error?'<p>'+errorDetailsHtml(cancel.error)+'</p>':'')+
   (active&&!shipped&&o.erp_live?.bc?.id&&cancel?.status!=='complete'?'<button type="button" '+(pending?'data-verify-erplain>Vérifier le résultat dans ERPLAIN':'data-cancel-erplain>Annuler dans ERPLAIN')+'</button>':'')+
   (shipped?'<p>Commande expédiée ou livrée : la suspension la retire des problèmes actifs. Ses statuts, documents et étiquettes restent conservés. L’annulation ERPLAIN est indisponible.</p>':'')+
   '<p>La commande client conserve son statut sur la plateforme. Les étiquettes existantes sont conservées.</p><section data-cancel-confirmation hidden aria-labelledby="cancel-confirm-title" tabindex="-1"></section></section>'+
   '<div data-suspension-message role="status" aria-live="polite" hidden></div>'+
   '<form><h3>'+(active?'Réactiver dans V3':'Suspendre dans V3')+'</h3><label>Note obligatoire pour '+(active?'réactiver':'suspendre')+'<textarea name="note" required maxlength="2000" rows="3" placeholder="Motif de la '+(active?'réactivation':'suspension')+'">'+esc(note)+'</textarea></label>'+
   '<p>'+(active?'La réactivation ne relance aucun traitement automatiquement.':'La commande sera retirée des problèmes à traiter et placée dans « Commandes suspendues ».')+'</p><button type="submit" class="primary" '+(pending?'disabled':'')+'>'+(active?'Réactiver la commande':'Suspendre la commande')+'</button></form>'+
   '<details><summary>Historique ('+context.history.length+')</summary>'+context.history.map(h=>'<p><strong>'+esc(({suspended:'Commande suspendue',reactivated:'Commande réactivée',erplain_cancellation_started:'Annulation ERPLAIN engagée',erplain_cancelled:'Annulation ERPLAIN confirmée',erplain_cancellation_review:'Annulation ERPLAIN à vérifier'})[h.action]||h.action)+'</strong><br>'+esc(h.note)+'<br><small>'+esc(date(h.created_at))+' · '+esc(h.user_email)+'</small></p>').join('')+'</details>';
  dialog.querySelector('[data-close-suspension]').onclick=()=>{if(!busy)dialog.close();};
  dialog.querySelector('form').onsubmit=e=>{e.preventDefault();if(busy||pending)return;const note=dialog.querySelector('textarea').value.trim();if(!note){feedback('Renseigner le motif avant de valider.',true);dialog.querySelector('textarea').focus();return;}submit(active?'reactivate':'suspend',{note});};
  const cancelButton=dialog.querySelector('[data-cancel-erplain]');
  if(cancelButton)cancelButton.onclick=()=>{
   if(busy)return;feedback('');const box=dialog.querySelector('[data-cancel-confirmation]');box.hidden=false;
   box.innerHTML='<h3 id="cancel-confirm-title">Confirmer l’annulation ERPLAIN</h3><p>Commande <strong>'+esc(o.reference)+'</strong> · BC <strong>'+esc(o.erp_live.bc.label||o.erp_live.bc.id)+'</strong>.</p><p>Le BC et ses BL non expédiés seront annulés après contrôle. Les documents facturés, expédiés ou avec un mouvement de stock à rapprocher seront refusés. La commande restera suspendue dans V3.</p><div class="actions"><button type="button" class="primary" data-confirm-erplain>Confirmer l’annulation dans ERPLAIN</button><button type="button" data-back>Revenir sans annuler</button></div>';
   cancelButton.disabled=true;dialog.querySelector('form').hidden=true;
   box.querySelector('[data-confirm-erplain]').onclick=()=>submit('cancel-erplain',{confirm:true});
   box.querySelector('[data-back]').onclick=()=>{box.hidden=true;dialog.querySelector('form').hidden=false;cancelButton.disabled=false;cancelButton.focus();};
   box.scrollIntoView({block:'nearest'});box.focus();
  };
  const verify=dialog.querySelector('[data-verify-erplain]');if(verify)verify.onclick=()=>submit('cancel-erplain',{verifyOnly:true});
  if(localReadPending){
   dialog.querySelectorAll('button,textarea').forEach(b=>{if(!b.hasAttribute('data-close-suspension'))b.disabled=true;});
   const verify=document.createElement('button');verify.type='button';verify.textContent='Actualiser le résultat dans V3';
   verify.onclick=()=>refreshLocal(context.order.id,++readGeneration,message,true,'',true,pendingLocalActive);dialog.querySelector('[data-suspension-message]').after(verify);
  }
  feedback(message,error);
 }
 async function load(id){const result=await api('/api/orders/suspension?id='+encodeURIComponent(id));if(result.order?.id!==id)throw Error('La réponse ne correspond pas à la commande.');context=result;}
 async function refreshLocal(id,generation,message,failed=false,requestId='',alsoRefreshList=false,desiredActive=null){
  const readStarted=performance.now();
  try{
   const fresh=await api('/api/orders/suspension?id='+encodeURIComponent(id)+(requestId?'&requestId='+encodeURIComponent(requestId):''));
   if(generation!==readGeneration||busy)return;if(fresh.order?.id!==id)throw Error('La réponse ne correspond pas à la commande.');
   // Never change the version/BC behind an already displayed ERP confirmation.
   if(dialog.open&&dialog.querySelector('[data-cancel-confirmation]')?.hidden===false)return;
   // A fresh read can confirm an uncertain local result; it never resubmits it.
   context=fresh;localReadPending=false;
   if(dialog.open&&dialog.querySelector('[data-cancel-confirmation]')?.hidden!==false){
    const note=dialog.querySelector('textarea')?.value||'';
    const currentActive=fresh.order.suspension?.active===true,matches=desiredActive===null||currentActive===desiredActive;
    const confirmed=currentActive?'État confirmé : commande suspendue dans V3.':'État confirmé : commande non suspendue dans V3.';
    render(failed?(matches?confirmed:'État V3 relu. '+message):(matches?message:'L’état a changé depuis l’enregistrement. '+confirmed),!matches,note);
   }
  }catch(error){
   if(generation===readGeneration&&dialog.open)render(message+' · Historique et état non actualisés : '+error.message,true,dialog.querySelector('textarea')?.value||'');
  }finally{console.debug('order-suspension-read', {requestId,readMs:Math.round(performance.now()-readStarted)});}
  if(alsoRefreshList&&generation===readGeneration)void refreshList(generation,message);
 }
 async function refreshList(generation,message){
  try{await orders();}catch(error){if(generation===readGeneration&&dialog.open)feedback(message+' · Liste non actualisée : '+error.message,true);}
 }
 async function submit(action,extra){
  if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');const id=context.order.id,note=dialog.querySelector('textarea')?.value||'',generation=++readGeneration;
  dialog.querySelectorAll('button,textarea').forEach(x=>x.disabled=true);
  feedback(action==='cancel-erplain'?(extra.verifyOnly?'Vérification du résultat dans ERPLAIN…':'Contrôle des documents et annulation ERPLAIN en cours…'):'Enregistrement en cours…');
  let message='',failed=false,result;
  try{result=await api('/api/orders/'+action,{id,expectedVersion:context.order.suspension?.version||'',...extra});message=result.message||'Action enregistrée.';if(action==='cancel-erplain')uncertain=false;}
  catch(e){failed=true;message=e.message||'La demande a échoué.';if(action==='cancel-erplain')uncertain=true;}
  if(action!=='cancel-erplain'){
   pendingLocalActive=action==='suspend';
   // Only a committed POST result enables the success state, never optimism.
   if(!failed&&result?.suspension)context.order.suspension=result.suspension;
   localReadPending=failed;busy=false;dialog.removeAttribute('aria-busy');render(message,failed,failed?note:'');
   void refreshLocal(id,generation,message,failed,result?.requestId||'',false,pendingLocalActive);void refreshList(generation,message);return;
  }
  // Provider cancellation retains its existing reconciliation safeguards.
  try{await load(id);}catch(e){failed=true;message+=' · Le suivi V3 n’a pas pu être relu : '+e.message;}
  busy=false;dialog.removeAttribute('aria-busy');render(message,failed,failed?note:'');
  try{await orders();}catch(e){feedback(message+' · Liste non actualisée : '+e.message,true);}
 }
 document.addEventListener('click',async e=>{const button=e.target.closest('[data-order-suspension]');if(!button||busy||opening)return;opening=true;uncertain=false;localReadPending=false;pendingLocalActive=null;readGeneration++;
  try{await load(button.dataset.orderSuspension);render();if(!dialog.open)dialog.showModal();}catch(error){alert('Impossible d’ouvrir la suspension : '+displayErrorMessage(error));}finally{opening=false;}
 });
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 // Keep historical PDFs readable; prevent selecting or starting suspended rows.
 function decorate(){
  for(const box of document.querySelectorAll('[data-suspension-order]')){
   if(box.dataset.suspensionProcessed||!box.querySelector('strong'))continue;box.dataset.suspensionProcessed='true';
   const row=box.closest('tr'),checkbox=row.querySelector('input[data-id]');if(checkbox){checkbox.checked=false;checkbox.disabled=true;selected.delete(checkbox.dataset.id);}
   for(const button of row.querySelectorAll('button'))if(!button.hasAttribute('data-order-suspension')&&!button.hasAttribute('data-erplain-document-refresh')){button.disabled=true;button.title='Commande suspendue : réactiver avant de traiter';}
  }
 }
 new MutationObserver(decorate).observe($('order-rows'),{childList:true,subtree:true});decorate();
})();
