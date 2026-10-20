(()=>{
 const button=document.createElement('button');button.dataset.view='price-verification';button.textContent='Vérification des prix';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent==='Paramètres');
 (settings?.querySelector('div')||document.querySelector('nav')).append(button);
 const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/price-verification.css?v=20261015-percent-1';document.head.append(stylesheet);
 addView('price-verification',`<div class="panel padded"><h2>Vérification des prix des BC</h2><p>Compare le total du BC enregistré dans V3 au montant actuel de la plateforme. TEMU : « Montant total estimé du règlement ». Shopify : total actuel de la commande, taxes et livraison comprises. Comparaison au centime, dans la même devise.</p><div class="prices-controls"><label>Plateforme <select id="prices-channel"><option value="shopify">Shopify</option><option value="temu">TEMU</option></select></label><label>Pays <select id="prices-country"></select></label><label>Du <input id="prices-start" type="datetime-local" step="60"></label><label>Au <input id="prices-end" type="datetime-local" step="60"></label><button id="prices-run" class="primary" disabled>Lancer la vérification</button></div><p class="prices-help">Dates de commande, bornes incluses (minute de fin comprise). Heures locales du navigateur. Dates vides : toutes les commandes. Un pays par vérification · Comparaison au centime · La vérification ne modifie aucun prix. Le bouton « Corriger le prix » applique le montant plateforme au BC Erplain ouvert sans paiement, facture ni BL. Les prix des lignes sont ajustés proportionnellement, avec conservation des taux de TVA.</p><p id="prices-state" role="status" aria-live="polite"></p><div id="prices-summary" class="prices-summary" hidden></div><div class="prices-filter"><label>Filtrer la différence (%) <select id="prices-operator"><option value="all">Tous les résultats</option><option value="gt">Supérieur à (&gt;)</option><option value="lt">Inférieur à (&lt;)</option><option value="eq">Égal à (=)</option></select></label><label>Pourcentage <input id="prices-percent" type="number" step="0.01" placeholder="Ex. : 5" disabled></label><span id="prices-filter-count" role="status" aria-live="polite"></span></div><p class="prices-help">Différence (%) = (total BC V3 − total plateforme) / total plateforme × 100, arrondie à deux décimales. Valeur signée ; indisponible si le total plateforme est nul et l'écart non nul.</p><div class="table-wrap"><table><thead><tr><th>Commande</th><th>BC</th><th>Total BC V3</th><th>Total plateforme</th><th>Écart</th><th>Différence (%)</th><th>Résultat</th><th>Action</th></tr></thead><tbody id="prices-rows"><tr><td colspan="8" class="prices-empty">Sélectionnez une plateforme et un pays, puis lancez la vérification.</td></tr></tbody></table></div></div>`);
 let countries=[];const regionNames=new Intl.DisplayNames(['fr'],{type:'region'});
 const selectCountry=()=>{const select=$('prices-country');select.replaceChildren();for(const row of countries.filter(r=>r.channel===$('prices-channel').value)){const option=document.createElement('option');option.value=row.country;option.textContent=regionNames.of(row.country)+' ('+row.country+')';select.append(option);}$('prices-run').disabled=!select.options.length;if(!select.options.length){const option=document.createElement('option');option.textContent='Aucun pays disponible';select.append(option);}$('prices-state').textContent=select.options[0]?.value==='Aucun pays disponible'?'Aucune commande disponible pour cette plateforme.':'';};
 button.onclick=async()=>{show('price-verification');$('title').textContent='Vérification des prix';try{countries=(await api('/api/price-verification/options')).countries;selectCountry();}catch(e){$('prices-state').textContent=displayErrorMessage(e);}};
 $('prices-channel').onchange=selectCountry;
 const filterRows=()=>{
  const operator=$('prices-operator').value,input=$('prices-percent');input.disabled=operator==='all';
  const active=operator!=='all'&&input.value!==''&&input.validity.valid,threshold=Number(input.value);let visible=0,total=0;
  for(const row of $('prices-rows').children){if(!row.dataset.result)continue;total++;const percent=row.dataset.percent===''?null:Number(row.dataset.percent);row.hidden=active&&(percent===null||!(operator==='gt'?percent>threshold:operator==='lt'?percent<threshold:percent===threshold));if(!row.hidden)visible++;}
  $('prices-filter-count').textContent=total?visible+' / '+total+' commande(s) affichée(s)':'';
 };
 $('prices-operator').onchange=filterRows;$('prices-percent').oninput=filterRows;

 const renderResult=r=>{
   const tr=document.createElement('tr'),money=m=>m?`${Number(m.amount).toFixed(2)} ${m.currency}`:'—';
   tr.dataset.result='true';tr.dataset.percent=r.differencePercent==null?'':String(r.differencePercent);
   for(const value of [r.reference,r.bcId||'—',money(r.bc),money(r.source),r.difference==null?'—':r.difference.toFixed(2),r.differencePercent==null?'—':r.differencePercent.toFixed(2)+' %',r.status==='same'?'Même prix':r.status==='different'?"Ce n’est pas le même prix":'À vérifier : '+r.error]){const td=document.createElement('td');td.textContent=value;if(tr.children.length===6){const badge=document.createElement('span');badge.className='price-result price-'+r.status;badge.textContent=value;td.replaceChildren(badge);}tr.append(td);}
   const action=document.createElement('td');
   if(r.status==='different'){
    const fix=document.createElement('button');fix.textContent='Corriger le prix';
    fix.onclick=async()=>{
     error.textContent='';fix.disabled=true;fix.textContent='Correction…';
     try{
      const updated=await api('/api/price-verification/correct',{id:r.id,bcId:r.bcId,bc:r.bc,source:r.source});
      tr.children[2].textContent=money(updated.bc);tr.children[3].textContent=money(updated.source);
      tr.children[4].textContent=updated.difference.toFixed(2);tr.children[5].textContent=updated.differencePercent==null?'—':updated.differencePercent.toFixed(2)+' %';
      tr.children[6].textContent='Prix corrigé';tr.dataset.percent=updated.differencePercent==null?'':String(updated.differencePercent);
      fix.textContent='Corrigé';filterRows();
     }catch(e){fix.disabled=false;fix.textContent='Corriger le prix';error.textContent=displayErrorMessage(e);}
    };
    const error=document.createElement('span');error.setAttribute('role','status');action.append(fix,error);
   }
   tr.append(action);$('prices-rows').append(tr);filterRows();
 };
 $('prices-run').onclick=async()=>{
  const channel=$('prices-channel').value,country=$('prices-country').value;
  const startValue=$('prices-start').value,endValue=$('prices-end').value;
  if(Boolean(startValue)!==Boolean(endValue)||startValue&&(!Number.isFinite(Date.parse(startValue))||!Number.isFinite(Date.parse(endValue))||Date.parse(startValue)>Date.parse(endValue))){$('prices-state').textContent='Saisissez les deux dates avec une fin supérieure ou égale au début.';return;}
  const start=startValue?new Date(startValue).toISOString():null,end=endValue?new Date(Date.parse(endValue)+59999).toISOString():null;
  for(const id of ['prices-run','prices-channel','prices-country','prices-start','prices-end'])$(id).disabled=true;
  $('prices-rows').replaceChildren();filterRows();$('prices-summary').hidden=true;let cursor='',count=0;const counts={same:0,different:0,review:0};
  try{while(true){$('prices-state').textContent=`Vérification ${channel.toUpperCase()} / ${country} : ${count} commande(s)…`;const response=await api('/api/price-verification/next',{channel,country,cursor,start,end});if(response.done)break;cursor=response.cursor;count++;
   renderResult(response.result);
  }$('prices-state').textContent=`Vérification terminée : ${count} commande(s) · ${channel.toUpperCase()} / ${country}.`;
  }catch(e){$('prices-state').textContent='Vérification interrompue : '+displayErrorMessage(e);}
  finally{for(const id of ['prices-run','prices-channel','prices-country','prices-start','prices-end'])$(id).disabled=false;}
 };
})();
