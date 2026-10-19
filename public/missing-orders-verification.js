(()=>{
 const button=document.createElement('button');button.dataset.view='missing-orders';button.textContent='Commandes manquantes';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent==='Paramètres');
 (settings?.querySelector('div')||document.querySelector('nav')).append(button);
 addView('missing-orders',`<div class="panel padded"><h2>Vérification des commandes manquantes</h2><p>Recherchez les commandes de plus de 24 heures par défaut, absentes de V3. Pour TEMU, toutes les boutiques configurées sont consultées, tous pays confondus. Aucune commande n’est ajoutée.</p><div class="missing-toolbar"><label for="missing-platform">Plateforme<select id="missing-platform"><option value="shopify">Shopify</option><option value="temu">TEMU — tous pays</option></select></label><label for="missing-start">Date de début<input id="missing-start" type="datetime-local" step="60" required aria-describedby="missing-help"></label><label for="missing-before">Date de fin (facultative)<input id="missing-before" type="datetime-local" step="60" aria-describedby="missing-help"></label><button id="missing-run" class="primary" type="button">Lancer la vérification</button></div><p id="missing-help" class="missing-help">Heure locale. Historique des 60 derniers jours. Sans date de fin, la recherche s’arrête à il y a 24 h. La date de fin doit remonter à au moins 24 h ; elle est exclue des résultats.</p><p id="missing-state" role="status" aria-live="polite"></p><p id="missing-errors" role="alert"></p><div class="table-wrap"><table><thead><tr><th>Plateforme</th><th>Boutique</th><th>Commande</th><th>Date de création</th><th>Pays</th><th>Statut de commande (source)</th><th>V3</th></tr></thead><tbody id="missing-rows"></tbody></table></div></div>`);
 const localDate=at=>{const d=new Date(at);return new Date(at-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 function refreshBounds(){
  const at=Date.now();for(const id of ['missing-start','missing-before']){$(id).max=localDate(at-86400000);$(id).min=localDate(at-60*86400000+60000);}
  const start=Date.parse($('missing-start').value),end=$('missing-before').value?Date.parse($('missing-before').value):at-86400000;
  $('missing-before').setCustomValidity(Number.isFinite(start)&&start>=end?'La date de fin doit suivre la date de début.':'');
  const minutes=Math.floor((end-start)/60000);
  const duration=Number.isFinite(minutes)&&minutes>0?`${Math.floor(minutes/1440)} j ${Math.floor(minutes%1440/60)} h ${minutes%60} min`:Number.isFinite(minutes)?'Période invalide':'Choisissez une date de début';
  $('missing-help').textContent=`Heure locale. Durée sélectionnée : ${duration}. Sans date de fin, la recherche s’arrête à il y a 24 h. La date de fin doit remonter à au moins 24 h ; elle est exclue des résultats.`;
 }
 $('missing-start').value='2026-10-07T00:00';refreshBounds();$('missing-start').oninput=refreshBounds;$('missing-before').oninput=refreshBounds;
 const statusNames={UNFULFILLED:'Non traitée',FULFILLED:'Traitée',PARTIALLY_FULFILLED:'Partiellement traitée',IN_PROGRESS:'En cours',ON_HOLD:'En attente',SCHEDULED:'Planifiée',CANCELLED:'Annulée',CANCELED:'Annulée'};
 const temuStatusNames={'1':'En attente','2':'À expédier','3':'Annulée','4':'Expédiée','5':'Reçue','41':'Partiellement expédiée','51':'Partiellement reçue'};
 const regionNames=new Intl.DisplayNames(['fr'],{type:'region'});
 const englishRegions=new Intl.DisplayNames(['en'],{type:'region'});
 const countryCodes=new Map();
 for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
  const code=String.fromCharCode(a,b),name=englishRegions.of(code);
  if(name!==code){countryCodes.set(name.toLowerCase(),code);countryCodes.set(regionNames.of(code).toLowerCase(),code);}
 }
 function countryName(value){
  const country=String(value||'').trim();
  if(!country||['—','--','__'].includes(country))return 'Pays non communiqué';
  const code=/^[a-z]{2}$/i.test(country)?country.toUpperCase():countryCodes.get(country.toLowerCase());
  return code?regionNames.of(code):country;
 }
 function sourceStatus(row){
  if(row.channel==='shopify')return statusNames[row.status]||row.status||'Non communiqué';
  const status=String(row.status??'');
  return status?(temuStatusNames[status]||'Statut non reconnu')+' (TEMU '+status+')':'Non communiqué';
 }
 function emptyRows(message){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=7;td.className='missing-empty';td.textContent=message;tr.append(td);$('missing-rows').replaceChildren(tr);}
 const filterLabel=document.createElement('label');filterLabel.htmlFor='missing-status';filterLabel.textContent='Statut de commande';
 const statusFilter=document.createElement('select');statusFilter.id='missing-status';filterLabel.append(statusFilter);
 const filterCount=document.createElement('p');filterCount.className='missing-filter-count';filterCount.setAttribute('role','status');filterCount.setAttribute('aria-live','polite');
 const filters=document.createElement('div');filters.className='missing-filters';filters.append(filterLabel,filterCount);
 $('missing-rows').closest('.table-wrap').before(filters);
 let report=null;
 function refreshStatuses(){
  const selected=statusFilter.value;statusFilter.replaceChildren(new Option('Tous les statuts',''));
  for(const status of [...new Set((report?.rows||[]).map(sourceStatus))].sort((a,b)=>a.localeCompare(b,'fr')))statusFilter.add(new Option(status,status));
  if([...statusFilter.options].some(option=>option.value===selected))statusFilter.value=selected;
  statusFilter.disabled=!report?.rows.length;
 }
 function renderReport(){
  if(!report)return;
  const rows=report.rows.filter(row=>!statusFilter.value||sourceStatus(row)===statusFilter.value);
  $('missing-rows').replaceChildren();
  for(const row of rows){const tr=document.createElement('tr');for(const value of [row.channel.toUpperCase(),row.shop,row.reference,new Date(row.date).toLocaleString('fr-FR'),countryName(row.country),sourceStatus(row),'Absente de V3']){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('missing-rows').append(tr);}
  if(!rows.length)emptyRows(report.rows.length?'Aucune commande pour ce statut.':report.done?(report.complete?'Aucune commande manquante sur la période sélectionnée.':'Aucune commande manquante détectée dans les résultats disponibles. La vérification est incomplète.'):'Recherche des commandes manquantes en cours…');
  filterCount.textContent=`${rows.length} commande(s) affichée(s) sur ${report.rows.length} absente(s) de V3`;
 }
 statusFilter.onchange=renderReport;refreshStatuses();
 emptyRows('Choisissez une plateforme puis lancez la vérification.');
 button.addEventListener('click',()=>{show('missing-orders');$('title').textContent='Vérification des commandes';});
 $('missing-run').onclick=async()=>{
  refreshBounds();
  if(!$('missing-start').reportValidity()||!$('missing-before').reportValidity())return;
  report=null;refreshStatuses();filterCount.textContent='';
  const control=$('missing-run');control.disabled=true;control.textContent='Vérification en cours…';$('missing-platform').disabled=true;$('missing-before').disabled=true;$('missing-start').disabled=true;emptyRows('Recherche des commandes manquantes en cours…');$('missing-errors').textContent='';$('missing-state').textContent='Lecture des API en cours…';
  try{
   let result=await api('/api/missing-orders/verify',{startDate:new Date($('missing-start').value).toISOString(),...($('missing-before').value?{beforeDate:new Date($('missing-before').value).toISOString()}:{}),platform:$('missing-platform').value});
   while(!result.done){
    result=await api('/api/missing-orders/verify',{runId:result.runId});
    report=result;refreshStatuses();renderReport();
    $('missing-errors').textContent=result.errors.map(e=>displayErrorMessage(e)).join(' · ');
    $('missing-state').textContent=`${result.done?(result.complete?'Vérification terminée':'Vérification incomplète'):'Lecture en cours'} · ${result.checked} commandes lues · ${result.rows.length} absentes de V3 · du ${new Date(result.start).toLocaleString('fr-FR')} au ${new Date(result.end).toLocaleString('fr-FR')} (heure locale).`;
   }
  }catch(e){$('missing-errors').textContent='Vérification interrompue : '+displayErrorMessage(e);$('missing-state').textContent='Résultats incomplets. Relancez la vérification.';if(!$('missing-rows').querySelector('tr:not(:has(.missing-empty))'))emptyRows('Lecture interrompue. Relancez la vérification.');}
  finally{control.disabled=false;control.textContent='Lancer la vérification';$('missing-platform').disabled=false;$('missing-before').disabled=false;$('missing-start').disabled=false;}
 };
})();
