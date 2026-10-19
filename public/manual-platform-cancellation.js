(()=>{
 const main=document.querySelector('main'),nav=document.querySelector('nav');if(!main||!nav)return;
 const view='platform-cancellations',panel=document.createElement('section');panel.id='view-'+view;panel.className='view';panel.hidden=true;
 const content=document.createElement('div');content.className='panel padded';panel.append(content);
 const heading=document.createElement('h2');heading.textContent='Annulations Temu / Shopify';content.append(heading);
 const explanation=document.createElement('p');explanation.textContent='Actualisez pour consulter les API Temu et Shopify et afficher les annulations des commandes non archivées. Cliquez ensuite sur « Appliquer les annulations » pour bloquer les traitements V3 et annuler les BC / BL Erplain admissibles. Les commandes expédiées, facturées ou avec un stock à rapprocher sont signalées pour vérification.';content.append(explanation);
 const controls=document.createElement('div');controls.className='cancellation-controls';content.append(controls);
 const label=document.createElement('label');label.textContent='Plateformes à vérifier ';const selection=document.createElement('select');selection.id='platform-cancellation-channels';
 for(const [value,text] of [['both','Temu / Shopify'],['temu','Temu'],['shopify','Shopify']]){const option=document.createElement('option');option.value=value;option.textContent=text;selection.append(option);}selection.value='both';label.append(selection);controls.append(label);
 const dateControls=[];
 for(const [id,text] of [['platform-cancellation-from','Commandes créées depuis le']]){const label=document.createElement('label');label.textContent=text;const input=document.createElement('input');input.type='datetime-local';input.step='60';input.id=id;input.value='';label.append(input);controls.append(label);dateControls.push(input);}
 const dateHelp=document.createElement('p');dateHelp.className='cancellation-help';dateHelp.textContent='Vérifie le statut actuel des commandes créées entre la date sélectionnée et maintenant (heure locale). Sans date, tout l’historique est vérifié.';content.append(dateHelp);
 const actions=document.createElement('div');actions.className='cancellation-actions';controls.append(actions);
 const button=document.createElement('button');button.type='button';button.textContent='Actualiser les annulations';button.id='platform-cancellation-refresh';
 button.className='primary';actions.append(button);
 const applyButton=document.createElement('button');applyButton.type='button';applyButton.textContent='Appliquer les annulations';applyButton.id='platform-cancellation-apply';applyButton.disabled=true;actions.append(applyButton);
 const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent='Export Excel';exportButton.id='platform-cancellation-export';exportButton.disabled=true;actions.append(exportButton);
 let results=[],issues=[],running=false,runLabel='',scanComplete=false,reportId='';
 const historyLabel=document.createElement('label');historyLabel.textContent='Rapports récents ';
 const history=document.createElement('select');history.id='platform-cancellation-history';historyLabel.append(history);
 const initialHistory=document.createElement('option');initialHistory.value='';initialHistory.textContent='Rapports récents…';history.append(initialHistory);
 const states={checking:'Vérification en cours',ready:'Vérifié',applying:'Application en cours',complete:'Application terminée',interrupted:'Interrompu'};
 async function loadHistory(){const response=await api('/api/orders/platform-cancellations/history');history.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Rapports récents…';history.append(placeholder);for(const row of response.rows||[]){const option=document.createElement('option');option.value=row.id;option.textContent=new Date(row.created_at).toLocaleString('fr-FR')+' · '+(states[row.status]||row.status);history.append(option);}history.value=reportId;}
 async function saveReport(){if(!reportId)return;await api('/api/orders/platform-cancellations/finish',{reportId,issues});await loadHistory();}
 history.onchange=async()=>{if(running||!history.value)return;try{const saved=await api('/api/orders/platform-cancellations/report?id='+encodeURIComponent(history.value));reportId=saved.id;results=saved.results;issues=saved.issues;scanComplete=saved.scan_complete;selection.value=saved.scope.channels.length===2?'both':saved.scope.channels[0];const at=saved.scope.createdFrom?new Date(saved.scope.createdFrom):null;dateControls[0].value=at?new Date(at.getTime()-at.getTimezoneOffset()*60000).toISOString().slice(0,16):'';runLabel='Rapport du '+new Date(saved.created_at).toLocaleString('fr-FR')+' · '+(states[saved.status]||saved.status);render();}catch(error){issues.push(error.message);render();}};

 const statuses={unchanged:'Non annulée sur la plateforme',review:'À vérifier'};
 const cancelledInV3=row=>row.v3Cancelled===true||row.applied===true;
 const confirmedOnPlatform=row=>row.platformCancelled===true||(row.platformCancelled==null&&row.status==='cancelled');
 const resultLabel=row=>row.status==='review'?statuses.review:cancelledInV3(row)?'Annulée dans V3':confirmedOnPlatform(row)?'Annulation plateforme confirmée — à appliquer dans V3':statuses[row.status]||row.status;
 const regionNames=new Intl.DisplayNames(['fr'],{type:'region'});
 const englishNames=new Intl.DisplayNames(['en'],{type:'region'}),countryCodes=new Map();
 for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b),name=englishNames.of(code);if(name!==code)countryCodes.set(name.toLowerCase(),code);}
 const countryName=value=>{const name=String(value||'').trim();const code=/^[a-z]{2}$/i.test(name)?name.toUpperCase():countryCodes.get(name.toLowerCase());return code?regionNames.of(code):name||'Pays non communiqué';};
 const filterLabel=document.createElement('label');filterLabel.textContent='Résultat affiché ';
 const statusFilter=document.createElement('select');statusFilter.id='platform-cancellation-status';
 for(const [value,text] of [['all','Tous les résultats'],['cancelled','Annulations plateforme confirmées'],['unchanged','Non annulées'],['review','À vérifier']]){const option=document.createElement('option');option.value=value;option.textContent=text;statusFilter.append(option);}statusFilter.value='all';filterLabel.append(statusFilter);
 const filters=document.createElement('div');filters.className='cancellation-filters';filters.append(historyLabel,filterLabel);content.append(filters);
 const visibleResults=()=>results.filter(row=>statusFilter.value==='all'||row.status===statusFilter.value);
 const report=document.createElement('div');report.id='platform-cancellation-report';content.append(report);main.append(panel);
 const menu=document.createElement('button');menu.type='button';menu.dataset.view=view;menu.textContent='Annulations Temu / Shopify';menu.id='platform-cancellations-menu';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent.trim()==='Paramètres');
 (settings?.querySelector('div')||nav).append(menu);
 if(settings)settings.open=true;
 const previousShow=show;show=async function(requested){if(requested!==view)return previousShow(requested);currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==panel.id);document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('title').textContent=heading.textContent;};
 menu.onclick=async()=>{if(settings)settings.open=true;await show(view);try{await loadHistory();}catch(error){issues.push(error.message);render();}};
 const render=()=>{const displayed=visibleResults();history.disabled=running;report.replaceChildren();const summary=document.createElement('p');summary.className='cancellation-summary';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');summary.textContent=runLabel?`${runLabel} · ${results.length} commandes vérifiées · ${results.filter(confirmedOnPlatform).length} annulations plateforme confirmées · ${results.filter(cancelledInV3).length} annulées dans V3 · ${results.filter(r=>r.status==='review').length} à vérifier · ${running?'En cours…':issues.length?'Terminé avec des alertes':'Terminé'}`:'Sélectionnez les plateformes puis lancez une vérification.';report.append(summary);
  const metrics=document.createElement('div');metrics.className='cancellation-metrics';for(const [label,value,warning] of [['Commandes vérifiées',results.length],['Annulations plateforme confirmées',results.filter(confirmedOnPlatform).length],['Annulées dans V3',results.filter(cancelledInV3).length],['À appliquer dans V3',results.filter(r=>confirmedOnPlatform(r)&&!cancelledInV3(r)).length],['Non annulées',results.filter(r=>r.status==='unchanged').length],['À vérifier',results.filter(r=>r.status==='review').length,true]]){const card=document.createElement('div');card.className='cancellation-metric'+(warning?' is-review':'');const title=document.createElement('span'),count=document.createElement('strong');title.textContent=label;count.textContent=String(value);card.append(title,count);metrics.append(card);}report.append(metrics);
  const title=document.createElement('h3');title.textContent='Compte rendu des vérifications';report.append(title);
  const wrapper=document.createElement('div');wrapper.className='cancellation-table';wrapper.setAttribute('tabindex','0');wrapper.setAttribute('aria-label','Compte rendu des vérifications');
  const table=document.createElement('table');table.id='platform-cancellation-results';const caption=document.createElement('caption');caption.textContent='Résultats par commande';caption.hidden=true;table.append(caption);const thead=document.createElement('thead'),head=document.createElement('tr');for(const text of ['Plateforme','Référence commande','Pays','Annulée sur Temu / Shopify','Annulée dans V3','Résultat','Compte rendu']){const cell=document.createElement('th');cell.setAttribute('scope','col');cell.textContent=text;head.append(cell);}thead.append(head);table.append(thead);const tbody=document.createElement('tbody');
  for(const result of displayed){const row=document.createElement('tr');for(const [index,text] of [result.channel==='temu'?'Temu':'Shopify',result.reference,countryName(result.country),confirmedOnPlatform(result)?'Oui':result.platformCancelled===false?'Non':'Non confirmé',cancelledInV3(result)?'Oui':result.v3Cancelled===false?'Non':'Non confirmé',resultLabel(result),result.error||(result.status==='cancelled'?(result.applied||result.v3Cancelled?'Annulation appliquée dans V3.':'Annulation confirmée sur la plateforme, à appliquer dans V3.'):'Aucune annulation confirmée sur la plateforme.')].entries()){const cell=document.createElement('td');if(index===5){const badge=document.createElement('span');badge.className='badge '+(result.status==='review'?'warn':cancelledInV3(result)?'green':confirmedOnPlatform(result)?'warn':'');badge.textContent=text;cell.append(badge);}else cell.textContent=text;row.append(cell);}tbody.append(row);}
  if(!displayed.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.setAttribute('colspan','7');cell.className='cancellation-empty';cell.textContent=results.length?'Aucune commande pour ce filtre.':running?'Vérification en cours. Les résultats apparaîtront ici au fur et à mesure.':runLabel?'Aucune commande à vérifier pour les plateformes sélectionnées.':'Aucun compte rendu pour le moment. Lancez une vérification pour afficher les résultats.';row.append(cell);tbody.append(row);}table.append(tbody);wrapper.append(table);report.append(wrapper);
  for(const issue of issues){const line=document.createElement('p');line.className='cancellation-notice';line.textContent=issue;report.append(line);}exportButton.disabled=running||!results.length;applyButton.disabled=running||!scanComplete||!results.some(r=>r.status==='cancelled'&&!cancelledInV3(r));
 };
 statusFilter.onchange=render;
 render();
 exportButton.onclick=async()=>{exportButton.disabled=true;try{const response=await fetch('/api/orders/platform-cancellations/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({results:visibleResults().map(row=>({...row,country:countryName(row.country)})),issues,platforms:runLabel})});if(!response.ok)throw Error('Export Excel indisponible');const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='annulations-temu-shopify.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){issues.push(error.message);render();}finally{exportButton.disabled=running||!results.length;}};
 button.onclick=async()=>{
  if(running)return;
  const range={},[from]=dateControls;
  try{
   if(from.value){const at=Date.parse(from.value);if(!Number.isFinite(at))throw Error('Date invalide');range.createdFrom=new Date(at).toISOString();range.createdTo=new Date().toISOString();if(range.createdFrom>range.createdTo)throw Error('Choisissez une date dans le passé.');}
  }catch(error){issues=[error.message];render();return;}
  for(const input of dateControls)input.disabled=true;
  running=true;scanComplete=false;button.disabled=true;selection.disabled=true;exportButton.disabled=true;let cursor='',unknownDates=0;results=[];issues=[];reportId='';
  const channels=selection.value==='both'?['temu','shopify']:[selection.value];runLabel=channels.map(c=>c==='temu'?'Temu':'Shopify').join(' / ')+(from.value?' · Du '+new Date(range.createdFrom).toLocaleString('fr-FR')+' au '+new Date(range.createdTo).toLocaleString('fr-FR'):'');
  try{
   render();
   while(true){const response=await api('/api/orders/refresh-platform-cancellations',{cursor,channels,...range,reportId});reportId=response.reportId||reportId;if(response.done){scanComplete=true;break;}if(!response.cursor||response.cursor===cursor)throw Error('Progression de la vérification invalide');cursor=response.cursor;if(response.skipped){if(response.unknownDate)unknownDates++;}else results.push(response.result);render();}
  }catch(error){issues.push('Vérification interrompue : '+error.message);render();}
  finally{if(unknownDates)issues.push(unknownDates+' commande(s) exclue(s) : date de création inconnue.');try{await saveReport();}catch(error){issues.push('Enregistrement du rapport : '+error.message);}running=false;button.disabled=false;selection.disabled=false;for(const input of dateControls)input.disabled=false;render();}
 };
 applyButton.onclick=async()=>{
  if(running||!scanComplete)return;
  const pending=results.filter(r=>r.status==='cancelled'&&!cancelledInV3(r));
  if(!pending.length)return;
  running=true;button.disabled=true;selection.disabled=true;render();
  try{
   for(const row of pending){
    try{
     const response=await api('/api/orders/apply-platform-cancellations',{id:row.id,channels:[row.channel],reportId});
     if(!response.result||response.result.id!==row.id)throw Error('Résultat d’annulation invalide');
     results[results.indexOf(row)]=response.result;
    }catch(error){issues.push('Application interrompue pour '+row.reference+' : '+error.message);break;}
    render();
   }
  }finally{try{await saveReport();}catch(error){issues.push('Enregistrement du rapport : '+error.message);}running=false;button.disabled=false;selection.disabled=false;render();}
 };
})();
