(()=>{
 const anchor=$('reload');if(!anchor)return;
 const actions=anchor.closest('.order-filter-actions')||anchor.closest('.filters')||anchor.parentElement;if(!actions)return;
 const button=document.createElement('button');button.type='button';button.textContent='Actualiser les annulations Temu / Shopify';button.id='platform-cancellation-refresh';
 anchor.after(button);
 const report=document.createElement('div');report.setAttribute('role','status');report.setAttribute('aria-live','polite');actions.after(report);
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
