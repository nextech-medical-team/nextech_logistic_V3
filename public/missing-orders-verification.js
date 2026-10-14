(()=>{
 const button=document.createElement('button');button.dataset.view='missing-orders';button.textContent='Vérification des commandes';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent==='Paramètres');
 (settings?.querySelector('div')||document.querySelector('nav')).append(button);
 addView('missing-orders',`<div class="panel padded"><h2>Vérification des commandes manquantes</h2><p>Commandes Shopify et TEMU de plus de 24 heures absentes de V3. Toutes les boutiques TEMU configurées et tous les pays sont vérifiés. Consultation uniquement : aucune commande n’est ajoutée.</p><div class="filters"><label>Période : <input id="missing-days" type="number" min="2" max="60" value="28" style="width:80px"> jours (2 à 60)</label><button id="missing-run">Vérifier Shopify et TEMU</button></div><p>La couverture dépend des boutiques connectées et de l’historique accessible par leurs API.</p><p id="missing-state" role="status" aria-live="polite"></p><p id="missing-errors" role="alert"></p><div class="table-wrap"><table><thead><tr><th>Plateforme</th><th>Boutique</th><th>Commande</th><th>Date de création</th><th>Pays</th><th>Statut source</th><th>V3</th></tr></thead><tbody id="missing-rows"></tbody></table></div></div>`);
 button.addEventListener('click',()=>{show('missing-orders');$('title').textContent='Vérification des commandes';});
 $('missing-run').onclick=async()=>{
  const control=$('missing-run');control.disabled=true;$('missing-rows').replaceChildren();$('missing-errors').textContent='';$('missing-state').textContent='Lecture des API en cours…';
  try{
   let result=await api('/api/missing-orders/verify',{days:Number($('missing-days').value)});
   while(!result.done){
    result=await api('/api/missing-orders/verify',{runId:result.runId});
    $('missing-rows').replaceChildren();
    for(const row of result.rows){const tr=document.createElement('tr');for(const value of [row.channel.toUpperCase(),row.shop,row.reference,new Date(row.date).toLocaleString('fr-FR'),row.country||'—',row.status,'Absente de V3']){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('missing-rows').append(tr);}
    $('missing-errors').textContent=result.errors.join(' · ');
    $('missing-state').textContent=`${result.done?(result.complete?'Vérification terminée':'Vérification incomplète'):'Lecture en cours'} · ${result.checked} commandes lues · ${result.rows.length} absentes de V3 · du ${new Date(result.start).toLocaleString('fr-FR')} au ${new Date(result.end).toLocaleString('fr-FR')} (plus de 24 h).`;
   }
  }catch(e){$('missing-errors').textContent='Vérification interrompue : '+e.message;$('missing-state').textContent='Résultats incomplets. Relancez la vérification.';}
  finally{control.disabled=false;}
 };
})();
