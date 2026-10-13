(()=>{
 const status=$('status');status.add(new Option('Différées · problèmes reportés','__deferred'));
 const filter=document.createElement('button');filter.type='button';filter.textContent='Commandes différées';$('suspended-orders-filter').after(filter);
 filter.onclick=()=>{resetFilters();if($('problem-type'))$('problem-type').selectedIndex=-1;status.value='__deferred';compactFilters.forEach(x=>x.sync());page=1;show('orders');};
 const modal=document.createElement('dialog');modal.className='order-suspension-dialog';modal.setAttribute('aria-labelledby','deferral-title');document.body.append(modal);
 let context=null,busy=false,request=0;
 function render(message='',error=false,note=''){
  const {order,state,history}=context,active=state.active===true;
  modal.innerHTML='<header><h2 id="deferral-title">'+esc(order.reference)+'</h2><button type="button" data-close-deferral>Fermer</button></header>'+
   '<h3>'+(active?'Problème différé':'Différer le problème')+'</h3><p>Le problème sera masqué dans « Tous les problèmes actifs ». La commande reste accessible par recherche et dans « Commandes différées ».</p>'+
   '<p><strong>Les préparations, achats et traitements actuels continuent selon leurs règles existantes.</strong> Différer ne suspend pas la commande et ne résout pas son problème.</p>'+
   (state.note?'<p>Dernière note : '+esc(state.note)+'<br><small>'+esc(state.updatedBy)+' · '+esc(new Date(state.updatedAt).toLocaleString('fr-FR'))+'</small></p>':'')+
   (order.suspension?.active?'<p>Cette commande est également suspendue. Lever le report ne lèvera pas sa suspension.</p>':'')+
   '<p data-deferral-message role="'+(error?'alert':'status')+'" aria-live="polite">'+esc(message)+'</p><form><label>Note obligatoire<textarea name="note" required maxlength="2000" rows="3" placeholder="Motif du report ou de sa levée">'+esc(note)+'</textarea></label><button type="submit" class="primary">'+(active?'Remettre dans les problèmes actifs':'Différer le problème')+'</button></form>'+
   '<details><summary>Historique ('+history.length+')</summary>'+history.map(h=>'<p><strong>'+esc(h.action==='problem_deferred'?'Problème différé':'Report levé')+'</strong><br>'+esc(h.note)+'<br><small>'+esc(h.user_email)+' · '+esc(new Date(h.created_at).toLocaleString('fr-FR'))+'</small></p>').join('')+'</details>';
  modal.querySelector('[data-close-deferral]').onclick=()=>modal.close();
  modal.querySelector('form').onsubmit=async e=>{
   e.preventDefault();if(busy)return;const note=modal.querySelector('textarea').value.trim();if(!note){modal.querySelector('textarea').reportValidity();return;}
   busy=true;modal.setAttribute('aria-busy','true');modal.querySelectorAll('button,textarea').forEach(b=>b.disabled=true);
   modal.querySelector('[data-deferral-message]').textContent='Enregistrement du report dans V3…';
   let result='',failed=false;const id=context.order.id;
   try{const r=await api('/api/problem-deferral/'+(active?'restore':'defer'),{id,note,expectedVersion:state.version||''});result=r.message;}
   catch(e){result=e.message;failed=true;}
   try{context=await api('/api/problem-deferral?id='+encodeURIComponent(id));if(context.order.id!==id)throw Error('Réponse incohérente');}
   catch(e){result+=' · Résultat enregistré à vérifier : '+e.message;failed=true;}
   busy=false;modal.removeAttribute('aria-busy');render(result,failed,failed?note:'');
   try{await orders();}catch(e){modal.querySelector('[data-deferral-message]').textContent=result+' · Liste non actualisée : '+e.message;}
  };
 }
 document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-problem-deferral-id]');if(!b)return;e.preventDefault();if(busy)return;const token=++request,id=b.dataset.problemDeferralId;
  try{const data=await api('/api/problem-deferral?id='+encodeURIComponent(id));if(token!==request)return;if(data.order?.id!==id)throw Error('Réponse incohérente');context=data;render();if(!modal.open)modal.showModal();}
  catch(e){if(token===request)alert('Impossible d’ouvrir le report : '+e.message);}
 });
 document.addEventListener('keydown',e=>{const b=e.target.closest('[data-problem-deferral-id]');if(b&&e.key===' '){e.preventDefault();b.click();}});
 modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();else request++;});
})();
