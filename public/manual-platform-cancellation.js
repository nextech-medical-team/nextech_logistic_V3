(()=>{
 const main=document.querySelector('main'),nav=document.querySelector('nav');if(!main||!nav)return;
 const view='platform-cancellations',panel=document.createElement('section');panel.id='view-'+view;panel.className='view';panel.hidden=true;
 const content=document.createElement('div');content.className='panel padded';panel.append(content);
 const heading=document.createElement('h2');heading.textContent='Annulations Temu / Shopify';content.append(heading);
 const explanation=document.createElement('p');explanation.textContent='Lancez une vérification de toutes les commandes Temu et Shopify non archivées dans V3. Les annulations confirmées bloquent les traitements V3 et annulent les BC / BL Erplain admissibles. Les commandes expédiées, facturées ou avec un stock à rapprocher sont signalées pour vérification.';content.append(explanation);
 const button=document.createElement('button');button.type='button';button.textContent='Actualiser les annulations Temu / Shopify';button.id='platform-cancellation-refresh';
 button.className='primary';content.append(button);
 const report=document.createElement('div');report.id='platform-cancellation-report';report.setAttribute('role','status');report.setAttribute('aria-live','polite');content.append(report);main.append(panel);
 const menu=document.createElement('button');menu.type='button';menu.dataset.view=view;menu.textContent='Annulations Temu / Shopify';menu.id='platform-cancellations-menu';
 const ordersMenu=nav.querySelector('[data-view="orders"]');if(ordersMenu)ordersMenu.after(menu);else nav.append(menu);
 const previousShow=show;show=async function(requested){if(requested!==view)return previousShow(requested);currentView=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==panel.id);document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('title').textContent=heading.textContent;};
 menu.onclick=()=>show(view);
 button.onclick=async()=>{
  button.disabled=true;let cursor='',checked=0,cancelled=0;const issues=[];
  const render=()=>{report.replaceChildren();const summary=document.createElement('p');summary.textContent=`${checked} commandes vérifiées · ${cancelled} annulées · ${issues.length} à vérifier`;report.append(summary);for(const issue of issues){const line=document.createElement('p');line.textContent=issue;report.append(line);}};
  try{
   report.textContent='Lecture des plateformes et annulation dans V3 / Erplain en cours…';
   while(true){const response=await api('/api/orders/refresh-platform-cancellations',{cursor});if(response.done)break;if(!response.cursor||response.cursor===cursor)throw Error('Progression de la vérification invalide');cursor=response.cursor;checked++;if(response.result.status==='cancelled')cancelled++;if(response.result.status==='review')issues.push(response.result.reference+' : '+response.result.error);render();}
  }catch(error){issues.push('Vérification interrompue : '+error.message);render();}
  finally{button.disabled=false;try{await orders();}catch(error){issues.push('Liste non actualisée : '+error.message);render();}}
 };
})();
