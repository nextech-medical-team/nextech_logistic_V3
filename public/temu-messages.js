(()=>{
 const button=document.createElement('button');button.dataset.view='temu-messages';button.textContent='Temu message';
 (document.querySelector('nav [data-view="temu-reading"]')||document.querySelector('nav [data-view="orders"]')).after(button);

 addView('temu-messages',`<div class="panel tm-panel"><div class="tm-header"><div><div class="tm-heading"><h2>Messages clients</h2><span class="tm-access-badge" id="tm-access-badge">Vérification de l’accès</span></div><p>Consultation des conversations de vos boutiques Temu.</p></div><div class="tm-header-actions"><button id="tm-reset" type="button" hidden>Effacer les filtres</button><button id="tm-refresh" type="button">Actualiser</button></div></div>
 <div class="tm-summary" id="tm-sync"><p>Boutiques par pays<strong id="tm-countries">Chargement…</strong></p><p>Dernière synchronisation<strong id="tm-last-sync">Jamais</strong></p><p>Vérification des connexions<strong id="tm-last-check">Jamais</strong></p></div>
 <div class="tm-statistics"><article aria-labelledby="tm-unanswered-title"><div><h3 id="tm-unanswered-title">Non répondus</h3><strong id="tm-unanswered-count" aria-live="polite">Chargement…</strong><p>Conversations dont le dernier message client attend une réponse.</p><small id="tm-unanswered-scope">Tous les pays · toutes les pages</small></div><button type="button" id="tm-unanswered-filter" disabled>Voir les non répondus</button></article></div>
 <div class="tm-access-box" id="tm-access-box" role="status"><strong id="tm-access-title">Vérification de l’accès aux messages…</strong><p id="tm-access-summary"></p><details><summary>Détails de l’accès Temu</summary><p id="tm-access"></p><p id="tm-config"></p><div id="tm-coverage"></div></details></div>
 <div class="tm-toolbar"><label>Pays <select id="tm-country"><option value="">Tous les pays</option></select></label>
 <label>Réponse <select id="tm-response"><option value="">Tous</option><option value="answered">Répondu</option><option value="unanswered">Non répondu</option><option value="unknown">Inconnu</option></select></label>
 <label>Classement <select id="tm-sort"><option value="latest">Message le plus récent</option><option value="country">Pays, puis message le plus récent</option></select></label></div>
 <p id="tm-state" role="status" aria-live="polite"></p>
 <div class="table-wrap"><table aria-label="Messages clients Temu"><thead><tr><th scope="col">Pays</th><th scope="col">Client</th><th scope="col">Dernier message client<br><small>Heure de Paris</small></th><th scope="col">Répondu ou non</th></tr></thead><tbody id="tm-rows"></tbody></table></div>
 <div class="tm-footer"><div><p id="tm-count"></p><p id="tm-auto">Actualisation de l’écran chaque minute</p><small id="tm-auto-note">La récupération des messages dépend de l’accès API Temu.</small></div><div class="tm-pages"><button id="tm-prev" type="button" disabled>Précédent</button><button id="tm-next" type="button" disabled>Suivant</button></div></div>
 <dialog id="tm-dialog"><h3>Conversation</h3><pre id="tm-content"></pre><button id="tm-close" type="button">Fermer</button></dialog></div>`);
 let page=1,sequence=0,refreshing=false,loading=false;
 const date=v=>v?new Date(v).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})+' (Paris)':'Jamais';
 const states={answered:'Répondu',unanswered:'Non répondu',unknown:'Inconnu'};
 const countryNames=new Intl.DisplayNames(['fr'],{type:'region'});
 const countryLabel=code=>/^[A-Z]{2}$/.test(code||'')?(countryNames.of(code)||code)+' ('+code+')':'Pays non communiqué';
 const emptyIcon='<svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>';
 function updateFilters(){$('tm-reset').hidden=!$('tm-country').value&&!$('tm-response').value&&$('tm-sort').value==='latest';}
 async function load({silent=false}={}){
  const request=++sequence;loading=true;
  if(!silent){
  updateFilters();$('tm-unanswered-count').textContent='Chargement…';$('tm-unanswered-filter').disabled=true;$('tm-state').removeAttribute('data-error');$('tm-state').textContent='Chargement…';$('tm-prev').disabled=true;$('tm-next').disabled=true;
  $('tm-rows').innerHTML='<tr><td colspan="4">Chargement des conversations…</td></tr>';
  }
  $('tm-refresh').hidden=!['admin','manager','operator'].includes(user?.role);
  try{
   const d=await api('/api/temu/messages?'+new URLSearchParams({country:$('tm-country').value,response:$('tm-response').value,sort:$('tm-sort').value,page}));
   if(request!==sequence)return;page=d.page;
   $('tm-auto').textContent='Actualisation automatique · chaque minute · '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
   $('tm-auto-note').textContent=d.access.available?'Données conservées avec les filtres sélectionnés.':'Synchronisation des messages bloquée : accès API Temu à confirmer.';
   const selected=$('tm-country').value;
   const stats=d.statistics,statsAvailable=d.access.available&&stats?.available&&Number.isSafeInteger(stats.unanswered)&&stats.unanswered>=0;
   $('tm-unanswered-count').textContent=statsAvailable?stats.unanswered.toLocaleString('fr-FR'):'Indisponible';
   $('tm-unanswered-filter').disabled=!statsAvailable||stats.unanswered===0;
   $('tm-unanswered-scope').textContent=(selected?countryLabel(selected):'Tous les pays')+' · toutes les pages'+(!statsAvailable?' · accès aux messages requis':'');
   $('tm-country').innerHTML='<option value="">Tous les pays</option>'+[...new Set([...d.countries,...(selected?[selected]:[])])].map(c=>'<option value="'+esc(c)+'">'+esc(countryLabel(c))+'</option>').join('');$('tm-country').value=selected;
   $('tm-countries').textContent=d.countries.length?d.countries.map(countryLabel).join(' · '):'Aucun pays configuré';
   $('tm-access-badge').textContent=d.access.available?'Consultation disponible':'Accès à confirmer';
   $('tm-access-badge').hidden=d.access.available;
   $('tm-access').textContent=d.access.reason;
   $('tm-access-box').hidden=d.access.available;
   $('tm-access-title').textContent='Accès aux messages non confirmé';
   $('tm-access-summary').textContent='Les conversations apparaîtront ici lorsque l’accès à la messagerie Temu sera confirmé.';
   $('tm-last-sync').textContent=date(d.lastSyncAt);$('tm-last-check').textContent=date(d.lastCheckAt);
   $('tm-coverage').innerHTML=d.coverage.map(c=>'<p>'+esc(c.country||'Pays non communiqué')+' · '+esc(c.connection==='verified'?'Connexion boutique vérifiée · accès aux messages non vérifié':c.error)+'</p>').join('');
   $('tm-state').textContent='';$('tm-config').textContent=d.configurationAvailable?'':'Configuration des boutiques incomplète ou indisponible. Vérifiez les connexions Temu.';
   $('tm-rows').innerHTML=d.rows.map((r,i)=>'<tr><td>'+esc(r.country||'Pays non communiqué')+'</td><td>'+(r.has_content?'<button class="link-button" type="button" data-tm-open="'+i+'">'+esc(r.customer||'Client non communiqué')+'</button>':esc(r.customer||'Client non communiqué'))+'</td><td>'+esc(date(r.last_customer_at))+'</td><td>'+'<span class="tm-status tm-status-'+(Object.hasOwn(states,r.reply_status)?r.reply_status:'unknown')+'">'+esc(states[r.reply_status]||'Inconnu')+'</span>'+'</td></tr>').join('')||'<tr><td colspan="4">'+(d.access.available?'Aucune conversation pour ces filtres.':'Aucun message synchronisé : accès API aux conversations non vérifié.')+'</td></tr>';
   if(!d.rows.length)$('tm-rows').innerHTML='<tr><td colspan="4" class="tm-empty">'+emptyIcon+'<strong>'+(d.access.available?'Aucune conversation pour ces filtres':'Aucun message synchronisé')+'</strong><span>'+(d.access.available?'Modifiez les filtres pour consulter les autres conversations.':'Les messages ne sont pas encore accessibles. Aucune conversation client n’a été récupérée.')+'</span></td></tr>';
   $('tm-count').textContent=!d.access.available&&!d.total?'Aucune donnée de messagerie disponible':d.total+' conversation'+(d.total>1?'s':'')+' · Page '+d.page+' sur '+d.pages;
   document.querySelector('#view-temu-messages .tm-pages').hidden=!d.total;
   $('tm-prev').disabled=d.page<=1;$('tm-next').disabled=d.page>=d.pages;
   document.querySelectorAll('[data-tm-open]').forEach(b=>b.onclick=async()=>{
    const r=d.rows[Number(b.dataset.tmOpen)];$('tm-content').textContent='Chargement…';$('tm-dialog').showModal();
    try{const v=await api('/api/temu/messages/conversation?'+new URLSearchParams({shop:r.shop_id,id:r.conversation_id}));$('tm-content').textContent=typeof v.content==='string'?v.content:JSON.stringify(v.content,null,2);}catch(e){$('tm-content').textContent=displayErrorMessage(e);}
   });
  }catch(e){if(request!==sequence)return;$('tm-unanswered-count').textContent='Indisponible';$('tm-state').dataset.error='';$('tm-state').textContent=displayErrorMessage(e);$('tm-rows').innerHTML='<tr><td colspan="4" class="tm-empty">'+emptyIcon+'<strong>Lecture impossible</strong><span>Utilisez Actualiser pour réessayer.</span></td></tr>';$('tm-count').textContent='';document.querySelector('#view-temu-messages .tm-pages').hidden=true;}
  finally{if(request===sequence)loading=false;}
 }
 function autoRefresh(){
  if(document.hidden||$('app').hidden||currentView!=='temu-messages'||$('view-temu-messages').hidden||loading||refreshing||$('tm-dialog').open)return;
  load({silent:true});
 }
 setInterval(autoRefresh,60000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoRefresh();});
 const before=show;show=async function(view){if(view!=='temu-messages')return before(view);currentView=view;document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('title').textContent='Temu message';await load();};
 button.onclick=()=>show('temu-messages');
 for(const id of ['tm-country','tm-response','tm-sort'])$(id).onchange=()=>{page=1;load();};
 $('tm-reset').onclick=()=>{$('tm-country').value='';$('tm-response').value='';$('tm-sort').value='latest';page=1;load();};
 $('tm-unanswered-filter').onclick=()=>{$('tm-response').value='unanswered';page=1;load();};
 $('tm-prev').onclick=()=>{page--;load();};$('tm-next').onclick=()=>{page++;load();};$('tm-close').onclick=()=>$('tm-dialog').close();
 $('tm-refresh').onclick=async()=>{
  if(refreshing)return;refreshing=true;$('tm-refresh').disabled=true;$('tm-refresh').textContent='Vérification…';$('tm-refresh').setAttribute('aria-busy','true');$('tm-state').textContent='Vérification des connexions Temu…';let error;
  try{await api('/api/temu/messages/refresh',{});}catch(e){error=e;}
  try{await load();if(error){$('tm-state').dataset.error='';$('tm-state').textContent=error.status===409?'Synchronisation bloquée : accès API aux conversations non vérifié.':displayErrorMessage(error);}}finally{refreshing=false;$('tm-refresh').disabled=false;$('tm-refresh').textContent='Actualiser';$('tm-refresh').removeAttribute('aria-busy');}
 };
})();
