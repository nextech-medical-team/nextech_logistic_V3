(()=>{
 const anchor=document.getElementById('reload');if(!anchor)return;
 const launch=document.createElement('button');launch.type='button';launch.id='sync-tracking';launch.textContent='Synchroniser les statuts';
 const historyButton=document.createElement('button');historyButton.type='button';historyButton.textContent='Historique des suivis';
 anchor.after(launch,historyButton);
 const panel=document.createElement('dialog');panel.className='tracking-sync-dialog';panel.setAttribute('aria-labelledby','tracking-sync-title');
 panel.innerHTML=`<div class="tracking-sync-heading"><h2 id="tracking-sync-title">Suivis GLS, GOFO et TEMU</h2><button type="button" data-close aria-label="Fermer le suivi">Fermer</button></div>
 <p data-mode></p><p data-scope></p><p data-progress role="status" aria-live="polite"></p><p data-error role="alert" hidden></p>
 <form data-search-form><label>Rechercher une commande, un BL ou un suivi <input name="search" type="search" maxlength="200"></label><button>Rechercher</button><button type="button" data-again>Synchroniser à nouveau</button><button type="button" data-export title="Exporter toutes les pages de la recherche affichée">Télécharger Excel</button></form>
 <div class="tracking-sync-scroll"><table><thead><tr><th>Commande / BL</th><th>Transporteur / suivi</th><th>Statut transporteur</th><th>Statut Erplain</th><th>Dernière lecture / résultat</th><th>Historique</th></tr></thead><tbody data-rows></tbody></table></div>
 <div class="tracking-sync-pagination"><button type="button" data-prev>Précédent</button><span data-page></span><button type="button" data-next>Suivant</button></div>
 <section data-history hidden aria-live="polite"></section>`;
 document.body.append(panel);
 const find=s=>panel.querySelector(s);
 const labels={pending:'En attente',ready_to_ship:'Prêt à livrer',not_shipped:'Non expédié',shipped:'Expédié',in_transit:'En transit',delivered:'Livré',cancelled:'Annulé',exception:'Incident',unknown:'À vérifier',unpublished:'Brouillon'};
 const status=v=>v?labels[v]||v:'Non vérifié';
 const date=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('fr-FR'):'—';
 const outcome={updated:'BL Erplain mis à jour',proposed:'Mise à jour Erplain proposée',unchanged:'Statut inchangé',error:'À vérifier'};
 let page=1,search='',timer,busy=false,loading=false,options=null,runId=null,version=0,historyKey=null,historyCursor=null;
 const canLaunch=()=>user&&['admin','manager','operator'].includes(user.role);
 const fail=e=>{find('[data-error]').hidden=false;find('[data-error]').textContent=e.message||String(e);};
 const clearError=()=>{find('[data-error]').hidden=true;find('[data-error]').textContent='';};
 function buttons(){launch.disabled=busy||!canLaunch();find('[data-again]').disabled=busy||!canLaunch()||!options?.workerAvailable;}
 function schedule(){clearTimeout(timer);if(panel.open)timer=setTimeout(()=>refresh().catch(fail),3000);}
 async function refresh(){
  if(loading)return;loading=true;const requestVersion=version;
  try{
   const data=await api('/api/tracking-sync?'+new URLSearchParams({page,search}));
   if(!panel.open||requestVersion!==version)return;
   options=data;page=data.page;buttons();
   find('[data-mode]').textContent=data.reason;
   const active=data.runs.find(r=>['queued','running'].includes(r.status));
   const job=active||data.runs.find(r=>r.id===runId)||data.runs[0];
   if(job){const states={queued:'En attente',running:'En cours',complete:'Terminée',failed:'Échec',interrupted:'Interrompue'};
    find('[data-progress]').textContent=`${states[job.status]||job.status} · ${job.processed} / ${job.total} livraisons contrôlées · ${job.mode==='apply'?'V3 et Erplain':'V3 uniquement'} · ${date(job.created_at)}${job.counts?.error?' · '+job.counts.error+' erreur(s)':''}${job.error?' · '+job.error:''}`;
   }else find('[data-progress]').textContent=data.total?'Résultats enregistrés par le traitement automatique.':'Aucune synchronisation lancée depuis cet écran.';
   if(!data.workerAvailable)find('[data-progress]').textContent+=' Le service de synchronisation est actuellement indisponible.';
   find('[data-rows]').innerHTML=data.rows.length?data.rows.map(r=>{
    const v=r.result;
    return `<tr><td>${esc(r.reference)}<small>BL ${esc(v.blId||'absent')}${v.partialId?' · livraison partielle':''}</small></td><td>${esc((v.carrier||'').toUpperCase())}<small>${(v.tracking||[]).map(esc).join('<br>')||'Suivi absent'}</small></td><td>${esc(status(v.carrierStatus))}<small>${esc(date(v.carrierObservedAt))}</small></td><td>${esc(status(v.lastKnownErplain))}${v.outcome==='proposed'?'<small>Proposé : '+esc(status(v.proposed))+'</small>':''}</td><td>${esc(date(r.created_at))}<small>${esc(v.error||v.localError||outcome[v.outcome]||'')}${v.error&&!v.observedAt&&v.carrierObservedAt?' · dernier suivi connu conservé':''}</small></td><td><button type="button" data-history-key="${esc(r.target_key)}" data-reference="${esc(r.reference)}">Voir l’historique</button></td></tr>`;
   }).join(''):'<tr><td colspan="6">Aucun résultat. Lancez une synchronisation pour récupérer les suivis disponibles.</td></tr>';
   find('[data-page]').textContent=`${data.total} livraisons · page ${data.page} / ${data.pages}`;find('[data-prev]').disabled=page<=1;find('[data-next]').disabled=page>=data.pages;
  }finally{loading=false;schedule();}
 }
 async function synchronize(){
  if(busy||!canLaunch())return;busy=true;buttons();clearError();
  try{
   // Read capabilities immediately before queuing; POST never silently changes mode.
   const data=await api('/api/tracking-sync');options=data;
   const ids=typeof selected!=='undefined'&&selected.size?[...selected]:null;
   find('[data-scope]').textContent=ids?`${ids.length} commande(s) sélectionnée(s). Les résultats ci-dessous incluent aussi les lectures précédentes.`:'Toutes les commandes actives disposant d’un suivi de production. Les filtres du tableau ne limitent pas cette opération.';
   const response=await api('/api/tracking-sync',{ids,mode:data.canApply?'apply':'preview'});
   runId=response.run?.id||null;
   if(response.existing)find('[data-scope]').textContent='Une synchronisation est déjà en cours. Affichage de son avancement ; aucune seconde demande lancée.';
   await refresh();
  }catch(e){fail(e);}finally{busy=false;buttons();schedule();}
 }
 async function showHistory(key,reference,more=false){
  if(!more){historyKey=key;historyCursor=null;find('[data-history]').hidden=false;find('[data-history]').innerHTML='<h3></h3><div data-changes></div><div data-events></div><button type="button" data-more hidden>Changements plus anciens</button>';find('[data-history] h3').textContent='Historique · '+reference;}
  const params=new URLSearchParams({key});if(more&&historyCursor)params.set('before',historyCursor);
  const data=await api('/api/tracking-sync/history?'+params);if(historyKey!==key||!panel.open)return;
  const changes=data.changes.map(c=>`<li><strong>${esc(date(c.created_at))}</strong>${c.carrier_before!==c.carrier_after?'<div>Transporteur : '+esc(c.carrier_before?status(c.carrier_before):'Première lecture')+' → '+esc(status(c.carrier_after))+'</div>':''}${c.erplain_before!==c.erplain_after?'<div>Erplain : '+esc(c.erplain_before?status(c.erplain_before):'Première lecture')+' → '+esc(status(c.erplain_after))+'</div>':''}</li>`).join('');
  if(more)find('[data-changes] ul')?.insertAdjacentHTML('beforeend',changes);
  else find('[data-changes]').innerHTML='<h4>Changements observés dans V3 / Erplain</h4><ul>'+(changes||'<li>Aucun changement enregistré.</li>')+'</ul>';
  if(!more)find('[data-events]').innerHTML='<h4>Événements transmis par le transporteur</h4><ul>'+(data.events.map(e=>'<li>'+esc(date(e.at))+' · '+esc(e.tracking)+' · '+esc(e.label||e.code)+'</li>').join('')||'<li>Aucun événement reçu.</li>')+'</ul>';
  historyCursor=data.next;find('[data-more]').hidden=!data.next;find('[data-more]').onclick=()=>showHistory(key,reference,true).catch(fail);
 }
 function open(){if(!panel.open){version++;panel.showModal();}clearError();}
 launch.onclick=()=>{open();synchronize();};historyButton.onclick=()=>{open();refresh().catch(fail);};
 find('[data-again]').onclick=synchronize;find('[data-close]').onclick=()=>panel.close();
 find('[data-export]').onclick=async()=>{
  const button=find('[data-export]');if(button.disabled)return;button.disabled=true;button.textContent='Préparation Excel…';clearError();
  try{
   const response=await fetch('/api/tracking-sync/export.xlsx?'+new URLSearchParams({search}));
   if(!response.ok){let message='Téléchargement Excel impossible';try{message=(await response.json()).error||message;}catch{}throw Error(message);}
   if(!response.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))throw Error('Réponse Excel invalide. Reconnectez-vous puis réessayez.');
   const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
   link.href=url;link.download='suivi-statuts-v3-'+new Date().toISOString().slice(0,10)+'.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){fail(e);}finally{button.disabled=false;button.textContent='Télécharger Excel';}
 };
 find('[data-search-form]').onsubmit=e=>{e.preventDefault();search=e.target.elements.search.value;page=1;refresh().catch(fail);};
 find('[data-prev]').onclick=()=>{page--;refresh().catch(fail);};find('[data-next]').onclick=()=>{page++;refresh().catch(fail);};
 find('[data-rows]').onclick=e=>{const b=e.target.closest('[data-history-key]');if(b)showHistory(b.dataset.historyKey,b.dataset.reference).catch(fail);};
 panel.addEventListener('close',()=>{version++;clearTimeout(timer);if(typeof orders==='function'&&currentView==='orders')orders().catch(e=>flash(e.message,true));});
 setInterval(buttons,2000);buttons();
})();
