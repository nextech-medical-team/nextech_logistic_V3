(()=>{
 const body=document.getElementById('order-rows');if(!body)return;
 let busy=false,refreshTimer,latest=new Map(),latestObservedAt=null;
 const setText=(el,value)=>{if(el.textContent!==value)el.textContent=value;};
 function elapsed(since){
  if(!since||!Number.isFinite(new Date(since).getTime()))return 'Début non disponible';
  const seconds=Math.max(0,Math.floor((Date.now()-new Date(since).getTime())/1000));
  return seconds<60?`${seconds} s`:`${Math.floor(seconds/60)} min ${seconds%60} s`;
 }
 function durationText(state,since){const label=({active:'Traitement V3 actif depuis',blocked:'Blocage depuis',queued:'Attente depuis'})[state];return label?(elapsed(since)==='Début non disponible'?label.replace(' depuis','')+' · Début non disponible':label+' '+elapsed(since)):'État à actualiser · activité non confirmée';}
 function rowIds(){return [...body.querySelectorAll('[data-detail]')].map(e=>e.dataset.detail);}
 function paint(){
  const index=[...body.closest('table').querySelectorAll('thead th')].findIndex(th=>th.dataset.column==='label');
  if(index<0)return;
  for(const ref of body.querySelectorAll('[data-detail]')){
   const r=latest.get(ref.dataset.detail),cell=ref.closest('tr').cells[index];if(!cell)continue;
   let box=cell.querySelector('.order-processing'),button=ref.parentElement.querySelector('.processing-priority');
   if(!r?.stage&&!r?.previewPending&&!r?.priority&&!r?.canPrioritize&&!r?.monitoring?.blocked){box?.remove();button?.remove();continue;}
   if(!box){box=document.createElement('div');box.className='order-processing';
    for(const cls of ['processing-stage','processing-position','processing-elapsed','processing-reason','processing-preview','processing-signals','processing-other','monitoring-last','monitoring-next','monitoring-result','monitoring-step','monitoring-alert']){const line=document.createElement('div');line.className=cls;line.style.overflowWrap='anywhere';if(cls==='processing-other')line.style.whiteSpace='pre-line';if(cls==='processing-preview'){line.style.fontWeight='bold';line.style.color='#8a4b00';}box.append(line);}
    cell.append(box);
   }
   box.hidden=!r.stage&&!r.priority&&!r.previewPending&&!r.monitoring?.blocked;
   const monitor=r.monitoring,stamp=value=>value?new Date(value).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'À vérifier';
   setText(box.querySelector('.monitoring-last'),monitor?.lastCheck?'Dernière vérification : '+stamp(monitor.lastCheck):'');
   setText(box.querySelector('.monitoring-next'),monitor?.nextCheck?'Prochain contrôle : '+stamp(monitor.nextCheck):'');
   setText(box.querySelector('.monitoring-result'),monitor?.result?'Résultat : '+monitor.result:'');
   setText(box.querySelector('.monitoring-step'),monitor?.nextStep?'Étape suivante : '+monitor.nextStep:'');
   const alert=box.querySelector('.monitoring-alert');setText(alert,monitor?.alert?'Sans progression depuis plus d’une heure · '+monitor.result+' · '+monitor.nextStep:'');alert.setAttribute('role','status');alert.style.fontWeight='bold';alert.style.color='#8a4b00';
   setText(box.querySelector('.processing-stage'),r.stage|| (r.monitoring?.blocked?'Contrôle des blocages':r.previewPending?'Remplacement à confirmer':'Priorité enregistrée · en attente de préparation'));
   const status=cell.querySelector(':scope > .badge');
   if(status&&r.stage&&(status.dataset.processingStatus||['Traitement en cours','À générer','En attente'].includes(status.textContent.trim()))){
    status.dataset.processingStatus='true';setText(status,r.state==='blocked'?'Bloquée':r.state==='active'?'Traitement en cours':'En attente');
   }
   setText(box.querySelector('.processing-position'),r.queue==='Erplain'?(r.inActiveBatch?`Lot en cours · en tête de file · ${r.activeCount} commande(s) en traitement · ${r.queueTotal} en attente`:r.position?`File Erplain · position ${r.position} / ${r.queueTotal} en attente${r.activeCount?` · ${r.activeCount} commande(s) déjà en traitement`:''}`:''):r.position?`File ${r.queue} · position ${r.position}`:'');
   const clock=box.querySelector('.processing-elapsed');clock.dataset.since=r.since||'';clock.dataset.state=r.state||'unknown';
   setText(clock,r.stage?durationText(r.state,r.since):'');
   clock.title='Durée de l’état enregistré dans V3. Un traitement actif ne prouve pas un appel continu chez le fournisseur.';
   setText(box.querySelector('.processing-reason'),r.reason?'Motif : '+r.reason:'');
   setText(box.querySelector('.processing-preview'),r.previewPending?'Équivalent '+r.previewPending.sku+' vérifié · remplacement NON enregistré. Ouvrez « Remplacer un produit » pour confirmer.':'');
   const observed=latestObservedAt?new Date(latestObservedAt).toLocaleTimeString('fr-FR'):'';
   setText(box.querySelector('.processing-signals'),r.stage?'État V3 actualisé à '+observed+(r.lastSignal?' · dernier signal V3 : '+new Date(r.lastSignal).toLocaleString('fr-FR'):'')+(r.state==='active'?' · appel fournisseur en continu non confirmé':''): '');
   setText(box.querySelector('.processing-other'),(r.activities||[]).filter(a=>a.service!==r.service||a.step!==r.step).map(a=>a.service+' · '+a.step+' · '+durationText(a.state,a.since)+(a.reason?' · '+a.reason:'')).join('\n'));
   if(!button){button=document.createElement('button');button.type='button';button.className='processing-priority';ref.parentElement.append(button);}
   button.dataset.priorityOrder=r.id;button.dataset.enabled=String(r.priority);
   button.disabled=false;button.hidden=!['admin','manager','operator'].includes(user?.role)||(!r.canPrioritize&&!r.priority);
   button.setAttribute('aria-pressed',String(r.priority));
   button.title=r.priority?'Retirer la priorité, sans interrompre le traitement':'Marquer cette commande urgente. La priorité sera appliquée dès que sa préparation pourra reprendre. Les blocages restent à corriger.';
   setText(button,r.priority?'★ Prioritaire · retirer':'☆ Rendre prioritaire');
  }
 }
 async function refresh(){
  if(busy||typeof currentView==='undefined'||currentView!=='orders'||document.hidden)return;
  const ids=rowIds();if(!ids.length)return;busy=true;
  try{const result=await api('/api/orders/processing',{ids});if(JSON.stringify(ids)!==JSON.stringify(rowIds()))return;latest=new Map(result.rows.map(r=>[r.id,r]));latestObservedAt=result.at;paint();}
  catch{for(const box of body.querySelectorAll('.order-processing')){setText(box.querySelector('.processing-position'),'Connexion interrompue · état actuel non confirmé');const clock=box.querySelector('.processing-elapsed');clock.dataset.since='';setText(clock,'Durée non actualisée · dernier état conservé');}for(const button of body.querySelectorAll('.processing-priority'))button.disabled=true;}
  finally{busy=false;}
 }
 body.addEventListener('click',async event=>{
  const button=event.target.closest('[data-priority-order]');if(!button)return;event.preventDefault();event.stopPropagation();button.disabled=true;
  try{const enabled=button.dataset.enabled!=='true';await api('/api/orders/priority',{id:button.dataset.priorityOrder,enabled});flash(enabled?'Priorité enregistrée pour la reprise. Les blocages restent à corriger et les traitements en cours continuent.':'Priorité retirée.');await refresh();}
  catch(e){flash(e.message,true);}finally{button.disabled=false;}
 });
 // Only new rows trigger a fetch. Updating the progress text never rebuilds the table.
 new MutationObserver(records=>{if(records.some(r=>r.target===body)){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,200);}}).observe(body,{childList:true});
 setInterval(refresh,5000);
 setInterval(()=>{if(document.hidden)return;for(const clock of body.querySelectorAll('.processing-elapsed[data-since]'))if(clock.dataset.since)setText(clock,durationText(clock.dataset.state,clock.dataset.since));},1000);
 refresh();
})();
