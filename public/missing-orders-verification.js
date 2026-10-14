(()=>{
 const button=document.createElement('button');button.dataset.view='missing-orders';button.textContent='Commandes manquantes';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent==='Paramètres');
 (settings?.querySelector('div')||document.querySelector('nav')).append(button);
 addView('missing-orders',`<div class="panel padded"><h2>Vérification des commandes manquantes</h2><p>Recherchez les commandes de plus de 24 heures par défaut, absentes de V3. Pour TEMU, toutes les boutiques configurées sont consultées, tous pays confondus. Aucune commande n’est ajoutée.</p><div class="missing-toolbar"><label for="missing-platform">Plateforme<select id="missing-platform"><option value="shopify">Shopify</option><option value="temu">TEMU — tous pays</option></select></label><label for="missing-hours">Ancienneté minimale (heures)<input id="missing-hours" type="number" min="24" max="720" step="1" value="24" required aria-describedby="missing-help"></label><button id="missing-run" class="primary" type="button">Lancer la vérification</button></div><p id="missing-help" class="missing-help">Minimum 24 h · 24 h par défaut · Affiche les commandes plus anciennes que ce seuil, dans l’historique accessible des 60 derniers jours.</p><p id="missing-state" role="status" aria-live="polite"></p><p id="missing-errors" role="alert"></p><div class="table-wrap"><table><thead><tr><th>Plateforme</th><th>Boutique</th><th>Commande</th><th>Date de création</th><th>Pays</th><th>Statut source</th><th>V3</th></tr></thead><tbody id="missing-rows"></tbody></table></div></div>`);
 function emptyRows(message){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.className='missing-empty';td.textContent=message;tr.append(td);$('missing-rows').replaceChildren(tr);}
 emptyRows('Choisissez une plateforme puis lancez la vérification.');
 button.addEventListener('click',()=>{show('missing-orders');$('title').textContent='Vérification des commandes';});
 $('missing-run').onclick=async()=>{
  if(!$('missing-hours').reportValidity())return;
  const control=$('missing-run');control.disabled=true;control.textContent='Vérification en cours…';$('missing-platform').disabled=true;$('missing-hours').disabled=true;emptyRows('Recherche des commandes manquantes en cours…');$('missing-errors').textContent='';$('missing-state').textContent='Lecture des API en cours…';
  try{
   let result=await api('/api/missing-orders/verify',{minimumAgeHours:Number($('missing-hours').value),platform:$('missing-platform').value});
   while(!result.done){
    result=await api('/api/missing-orders/verify',{runId:result.runId});
    $('missing-rows').replaceChildren();
    for(const row of result.rows){const tr=document.createElement('tr');for(const value of [row.channel.toUpperCase(),row.shop,row.reference,new Date(row.date).toLocaleString('fr-FR'),row.country||'—',row.status,'Absente de V3']){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('missing-rows').append(tr);}
    if(!result.rows.length)emptyRows(result.done?(result.complete?'Aucune commande manquante sur la période sélectionnée.':'Aucune commande manquante détectée dans les résultats disponibles. La vérification est incomplète.'):'Recherche des commandes manquantes en cours…');
    $('missing-errors').textContent=result.errors.join(' · ');
    $('missing-state').textContent=`${result.done?(result.complete?'Vérification terminée':'Vérification incomplète'):'Lecture en cours'} · ${result.checked} commandes lues · ${result.rows.length} absentes de V3 · du ${new Date(result.start).toLocaleString('fr-FR')} au ${new Date(result.end).toLocaleString('fr-FR')} (plus de ${result.minimumAgeHours} h).`;
   }
  }catch(e){$('missing-errors').textContent='Vérification interrompue : '+e.message;$('missing-state').textContent='Résultats incomplets. Relancez la vérification.';if(!$('missing-rows').querySelector('tr:not(:has(.missing-empty))'))emptyRows('Lecture interrompue. Relancez la vérification.');}
  finally{control.disabled=false;control.textContent='Lancer la vérification';$('missing-platform').disabled=false;$('missing-hours').disabled=false;}
 };
})();
