(()=>{
 const status=$('status');status.add(new Option('Suspendues · attente d’annulation client','__suspended'));
 const filter=document.createElement('button');filter.type='button';filter.textContent='Commandes suspendues';filter.id='suspended-orders-filter';$('all-problems').after(filter);
 filter.onclick=()=>{resetFilters();if($('problem-type'))$('problem-type').selectedIndex=-1;status.value='__suspended';compactFilters.forEach(x=>x.sync());page=1;show('orders');};
 const dialog=document.createElement('dialog');dialog.className='order-suspension-dialog';document.body.append(dialog);
 let context=null,busy=false;
 const date=value=>value?new Date(value).toLocaleString('fr-FR'):'';
 function render(message=''){
  const o=context.order,s=o.suspension||{},active=s.active===true,cancel=s.erplainCancellation;
  dialog.innerHTML='<form><h2>'+esc(o.reference)+'</h2><p><strong>'+(active?'Commande suspendue · attente d’annulation client':'Suspendre la commande')+'</strong></p>'+
   '<p>La suspension arrête les préparations et achats dans V3 et retire la commande du filtre des problèmes à traiter. La commande reste accessible par recherche et dans « Commandes suspendues ».</p>'+
   (s.note?'<p><strong>Dernière note :</strong> '+esc(s.note)+'<br><small>'+esc(date(s.updatedAt))+' · '+esc(s.updatedBy)+'</small></p>':'')+
   (cancel?'<p><strong>ERPLAIN :</strong> '+esc(cancel.status==='complete'?'Annulation confirmée':cancel.status==='processing'?'Annulation engagée · résultat à vérifier':'Annulation à vérifier')+' · '+esc(cancel.bcLabel||cancel.bcId)+(cancel.error?'<br>'+esc(cancel.error):'')+'</p>':'')+
   '<label>Note obligatoire<textarea name="note" required maxlength="2000" rows="4" placeholder="Motif de la suspension ou de la réactivation"></textarea></label>'+
   '<p>La commande client conserve son statut sur la plateforme. L’annulation ERPLAIN est une action séparée.</p>'+
   '<p role="status" data-suspension-message>'+esc(message)+'</p><div class="actions">'+
   (active?'<button type="submit" name="action" value="reactivate"'+(['processing','review'].includes(cancel?.status)?' disabled':'')+'>Réactiver la commande</button>':'<button type="submit" class="primary" name="action" value="suspend">Suspendre la commande</button>')+
   (active&&o.erp_live?.bc?.id&&cancel?.status!=='complete'?'<button type="button" data-cancel-erplain>Annuler dans ERPLAIN'+(cancel?' / Vérifier le résultat':'')+'</button>':'')+
   '<button type="button" data-close-suspension>Fermer</button></div><details><summary>Historique ('+context.history.length+')</summary>'+context.history.map(h=>'<p><strong>'+esc(({suspended:'Commande suspendue',reactivated:'Commande réactivée',erplain_cancellation_started:'Annulation ERPLAIN engagée',erplain_cancelled:'Annulation ERPLAIN confirmée',erplain_cancellation_review:'Annulation ERPLAIN à vérifier'})[h.action]||h.action)+'</strong><br>'+esc(h.note)+'<br><small>'+esc(date(h.created_at))+' · '+esc(h.user_email)+'</small></p>').join('')+'</details></form>';
  dialog.querySelector('[data-close-suspension]').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();if(busy)return;const action=e.submitter?.value;if(!['suspend','reactivate'].includes(action))return;const note=dialog.querySelector('textarea').value.trim();if(!note){dialog.querySelector('textarea').reportValidity();return;}await submit(action,{note});};
  const cancelButton=dialog.querySelector('[data-cancel-erplain]');
  if(cancelButton)cancelButton.onclick=()=>{
   if(busy)return;
   const message=dialog.querySelector('[data-suspension-message]');message.replaceChildren();
   const explanation=document.createElement('p');explanation.textContent='Confirmer l’annulation du BC '+(o.erp_live.bc.label||o.erp_live.bc.id)+' et de ses BL non expédiés dans ERPLAIN. V3 conserve la suspension, la note et l’historique. Les cas facturés, expédiés ou avec mouvement de stock à rapprocher seront refusés.';
   const confirm=document.createElement('button');confirm.type='button';confirm.textContent='Confirmer l’annulation dans ERPLAIN';confirm.onclick=()=>submit('cancel-erplain',{confirm:true});
   const back=document.createElement('button');back.type='button';back.textContent='Revenir';back.onclick=()=>render();message.append(explanation,confirm,back);
  };
 }
 async function load(id,message=''){context=await api('/api/orders/suspension?id='+encodeURIComponent(id));render(message);}
 async function submit(action,extra){
  if(busy)return;busy=true;const id=context.order.id;dialog.querySelectorAll('button,textarea').forEach(x=>x.disabled=true);
  dialog.querySelector('[data-suspension-message]').textContent=action==='cancel-erplain'?'Lecture des documents et annulation ERPLAIN en cours…':'Enregistrement en cours…';
  let message='';try{const result=await api('/api/orders/'+action,{id,expectedVersion:context.order.suspension?.version||'',...extra});message=result.message;}catch(e){message=e.message;}
  try{await load(id,message);await orders();}catch(e){dialog.querySelector('[data-suspension-message]').textContent=message+' · '+e.message;dialog.querySelector('[data-close-suspension]').disabled=false;}finally{busy=false;}
 }
 document.addEventListener('click',async e=>{const button=e.target.closest('[data-order-suspension]');if(!button||busy)return;try{await load(button.dataset.orderSuspension);dialog.showModal();}catch(error){alert(error.message);}});
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
