(()=>{
 const main=document.querySelector('main'),nav=document.querySelector('nav');if(!main||!nav)return;
 const view='platform-cancellations',panel=document.createElement('section');panel.id='view-'+view;panel.className='view';panel.hidden=true;
 const content=document.createElement('div');content.className='panel padded';panel.append(content);
 const heading=document.createElement('h2');heading.textContent='Annulations Temu / Shopify';content.append(heading);
 const explanation=document.createElement('p');explanation.textContent='Lancez une vérification de toutes les commandes Temu et Shopify non archivées dans V3. Les annulations confirmées bloquent les traitements V3 et annulent les BC / BL Erplain admissibles. Les commandes expédiées, facturées ou avec un stock à rapprocher sont signalées pour vérification.';content.append(explanation);
 const controls=document.createElement('div');controls.className='cancellation-controls';content.append(controls);
 const label=document.createElement('label');label.textContent='Plateformes à vérifier ';const selection=document.createElement('select');selection.id='platform-cancellation-channels';
 for(const [value,text] of [['both','Temu / Shopify'],['temu','Temu'],['shopify','Shopify']]){const option=document.createElement('option');option.value=value;option.textContent=text;selection.append(option);}selection.value='both';label.append(selection);controls.append(label);
 const button=document.createElement('button');button.type='button';button.textContent='Actualiser les annulations';button.id='platform-cancellation-refresh';
 button.className='primary';controls.append(button);
 const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent='Export Excel';exportButton.id='platform-cancellation-export';exportButton.disabled=true;controls.append(exportButton);
 let results=[],issues=[],running=false,runLabel='';
 const statuses={cancelled:'Annulée',unchanged:'Non annulée',review:'À vérifier'};
 const report=document.createElement('div');report.id='platform-cancellation-report';content.append(report);main.append(panel);
 const menu=document.createElement('button');menu.type='button';menu.dataset.view=view;menu.textContent='Annulations Temu / Shopify';menu.id='platform-cancellations-menu';
 const settings=[...document.querySelectorAll('nav .nav-group')].find(el=>el.querySelector('summary')?.textContent.trim()==='Paramètres');
 (settings?.querySelector('div')||nav).append(menu);
 if(settings)settings.open=true;
 const previousShow=show;show=async function(requested){if(requested!==view)return previousShow(requested);currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==panel.id);document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('title').textContent=heading.textContent;};
 menu.onclick=()=>{if(settings)settings.open=true;return show(view);};
 const render=()=>{report.replaceChildren();const summary=document.createElement('p');summary.className='cancellation-summary';summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');summary.textContent=runLabel?`${runLabel} · ${results.length} commandes vérifiées · ${results.filter(r=>r.status==='cancelled').length} annulées · ${results.filter(r=>r.status==='review').length} à vérifier · ${running?'En cours…':issues.length?'Terminé avec des alertes':'Terminé'}`:'Sélectionnez les plateformes puis lancez une vérification.';report.append(summary);
  const metrics=document.createElement('div');metrics.className='cancellation-metrics';for(const [label,value,warning] of [['Commandes vérifiées',results.length],['Annulées',results.filter(r=>r.status==='cancelled').length],['Non annulées',results.filter(r=>r.status==='unchanged').length],['À vérifier',results.filter(r=>r.status==='review').length,true]]){const card=document.createElement('div');card.className='cancellation-metric'+(warning?' is-review':'');const title=document.createElement('span'),count=document.createElement('strong');title.textContent=label;count.textContent=String(value);card.append(title,count);metrics.append(card);}report.append(metrics);
  const title=document.createElement('h3');title.textContent='Compte rendu des vérifications';report.append(title);
  const wrapper=document.createElement('div');wrapper.className='cancellation-table';wrapper.setAttribute('tabindex','0');wrapper.setAttribute('aria-label','Compte rendu des vérifications');
  const table=document.createElement('table');table.id='platform-cancellation-results';const caption=document.createElement('caption');caption.textContent='Résultats par commande';caption.hidden=true;table.append(caption);const thead=document.createElement('thead'),head=document.createElement('tr');for(const text of ['Plateforme','Référence commande','Résultat','Compte rendu']){const cell=document.createElement('th');cell.setAttribute('scope','col');cell.textContent=text;head.append(cell);}thead.append(head);table.append(thead);const tbody=document.createElement('tbody');
  for(const result of results){const row=document.createElement('tr');for(const [index,text] of [result.channel==='temu'?'Temu':'Shopify',result.reference,statuses[result.status]||result.status,result.error||(result.status==='cancelled'?'Annulation confirmée et appliquée dans V3.':'Aucune annulation confirmée sur la plateforme.')].entries()){const cell=document.createElement('td');if(index===2){const badge=document.createElement('span');badge.className='badge '+(result.status==='review'?'warn':result.status==='cancelled'?'green':'');badge.textContent=text;cell.append(badge);}else cell.textContent=text;row.append(cell);}tbody.append(row);}
  if(!results.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.setAttribute('colspan','4');cell.className='cancellation-empty';cell.textContent=running?'Vérification en cours. Les résultats apparaîtront ici au fur et à mesure.':runLabel?'Aucune commande à vérifier pour les plateformes sélectionnées.':'Aucun compte rendu pour le moment. Lancez une vérification pour afficher les résultats.';row.append(cell);tbody.append(row);}table.append(tbody);wrapper.append(table);report.append(wrapper);
  for(const issue of issues){const line=document.createElement('p');line.className='cancellation-notice';line.textContent=issue;report.append(line);}exportButton.disabled=running||!results.length;
 };
 render();
 exportButton.onclick=async()=>{exportButton.disabled=true;try{const response=await fetch('/api/orders/platform-cancellations/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({results,issues,platforms:runLabel})});if(!response.ok)throw Error('Export Excel indisponible');const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download='annulations-temu-shopify.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){issues.push(error.message);render();}finally{exportButton.disabled=running||!results.length;}};
 button.onclick=async()=>{
  if(running)return;running=true;button.disabled=true;selection.disabled=true;exportButton.disabled=true;let cursor='';results=[];issues=[];
  const channels=selection.value==='both'?['temu','shopify']:[selection.value];runLabel=channels.map(c=>c==='temu'?'Temu':'Shopify').join(' / ');
  try{
   render();
   while(true){const response=await api('/api/orders/refresh-platform-cancellations',{cursor,channels});if(response.done)break;if(!response.cursor||response.cursor===cursor)throw Error('Progression de la vérification invalide');cursor=response.cursor;results.push(response.result);render();}
  }catch(error){issues.push('Vérification interrompue : '+error.message);render();}
  finally{running=false;button.disabled=false;selection.disabled=false;render();}
 };
})();
