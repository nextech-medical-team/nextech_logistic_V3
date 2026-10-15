(()=>{
 const button=document.createElement('button');button.dataset.view='missing-orders';button.textContent='Commandes manquantes';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent==='Paramètres');
 (settings?.querySelector('div')||document.querySelector('nav')).append(button);
 addView('missing-orders',`<div class="panel padded"><h2>Vérification des commandes manquantes</h2><p>Recherchez les commandes de plus de 24 heures par défaut, absentes de V3. Pour TEMU, toutes les boutiques configurées sont consultées, tous pays confondus. Aucune commande n’est ajoutée.</p><div class="missing-toolbar"><label for="missing-platform">Plateforme<select id="missing-platform"><option value="shopify">Shopify</option><option value="temu">TEMU — tous pays</option></select></label><label for="missing-before">Commandes créées avant le<input id="missing-before" type="datetime-local" step="60" required aria-describedby="missing-help"></label><button id="missing-run" class="primary" type="button">Lancer la vérification</button></div><p id="missing-help" class="missing-help">Date et heure locales, au moins 24 h dans le passé (24 h par défaut), dans les 60 derniers jours. Affiche les commandes créées avant cet instant.</p><p id="missing-state" role="status" aria-live="polite"></p><p id="missing-errors" role="alert"></p><div class="table-wrap"><table><thead><tr><th>Plateforme</th><th>Boutique</th><th>Commande</th><th>Date de création</th><th>Pays</th><th>Statut de commande (source)</th><th>V3</th></tr></thead><tbody id="missing-rows"></tbody></table></div></div>`);
 const localDate=at=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 function refreshBounds(){const at=Date.now();$('missing-before').max=localDate(at-86400000);$('missing-before').min=localDate(at-60*86400000+60000);}
 refreshBounds();$('missing-before').value=$('missing-before').max;
 const statusNames={UNFULFILLED:'Non traitée',FULFILLED:'Traitée',PARTIALLY_FULFILLED:'Partiellement traitée',IN_PROGRESS:'En cours',ON_HOLD:'En attente',SCHEDULED:'Planifiée',CANCELLED:'Annulée',CANCELED:'Annulée'};
 function sourceStatus(row){return row.channel==='shopify'?(statusNames[row.status]||row.status||'Non communiqué'):(row.status==='3'?'Annulée (TEMU 3)':row.status?'Statut TEMU '+row.status:'Non communiqué');}
 function emptyRows(message){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.className='missing-empty';td.textContent=message;tr.append(td);$('missing-rows').replaceChildren(tr);}
 emptyRows('Choisissez une plateforme puis lancez la vérification.');
 button.addEventListener('click',()=>{show('missing-orders');$('title').textContent='Vérification des commandes';});
 $('missing-run').onclick=async()=>{
  refreshBounds();
  if(!$('missing-before').reportValidity())return;
  const control=$('missing-run');control.disabled=true;control.textContent='Vérification en cours…';$('missing-platform').disabled=true;$('missing-before').disabled=true;emptyRows('Recherche des commandes manquantes en cours…');$('missing-errors').textContent='';$('missing-state').textContent='Lecture des API en cours…';
  try{
   let result=await api('/api/missing-orders/verify',{beforeDate:new Date($('missing-before').value).toISOString(),platform:$('missing-platform').value});
   while(!result.done){
    result=await api('/api/missing-orders/verify',{runId:result.runId});
    $('missing-rows').replaceChildren();
    for(const row of result.rows){const tr=document.createElement('tr');for(const value of [row.channel.toUpperCase(),row.shop,row.reference,new Date(row.date).toLocaleString('fr-FR'),row.country||'—',sourceStatus(row),'Absente de V3']){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('missing-rows').append(tr);}
    if(!result.rows.length)emptyRows(result.done?(result.complete?'Aucune commande manquante sur la période sélectionnée.':'Aucune commande manquante détectée dans les résultats disponibles. La vérification est incomplète.'):'Recherche des commandes manquantes en cours…');
    $('missing-errors').textContent=result.errors.join(' · ');
    $('missing-state').textContent=`${result.done?(result.complete?'Vérification terminée':'Vérification incomplète'):'Lecture en cours'} · ${result.checked} commandes lues · ${result.rows.length} absentes de V3 · du ${new Date(result.start).toLocaleString('fr-FR')} au ${new Date(result.end).toLocaleString('fr-FR')} (heure locale).`;
   }
  }catch(e){$('missing-errors').textContent='Vérification interrompue : '+e.message;$('missing-state').textContent='Résultats incomplets. Relancez la vérification.';if(!$('missing-rows').querySelector('tr:not(:has(.missing-empty))'))emptyRows('Lecture interrompue. Relancez la vérification.');}
  finally{control.disabled=false;control.textContent='Lancer la vérification';$('missing-platform').disabled=false;$('missing-before').disabled=false;}
 };
})();
