(()=>{
 const nav=document.createElement('button');nav.dataset.view='equivalence-import';nav.textContent='Importer des équivalences';
 const anchor=document.querySelector('[data-view="equivalences"]')||document.querySelector('[data-view="mappings"]');if(!anchor)return;anchor.after(nav);
 const section=document.createElement('section');section.id='view-equivalence-import';section.className='view';section.hidden=true;
 section.innerHTML='<div class="panel padded"><h2>Importer des équivalences</h2><p>Importez un fichier XLSX contenant l’onglet « Onglet type » : Numéro de commande, SKU de base, SKU de remplacement, Qté de remplacement. Amazon, Shopify et TEMU uniquement.</p><form><label>Fichier Excel<input type="file" accept=".xlsx" required></label><button class="primary">Analyser le fichier</button></form><p role="status" aria-live="polite" data-feedback></p><div data-preview hidden><p>Les lignes applicables sont cochées par défaut. Décochez celles que vous souhaitez conserver. Les remplacements seront limités aux commandes sélectionnées.</p><div class="actions"><button type="button" data-all>Tout cocher</button><button type="button" data-none>Tout décocher</button><button type="button" data-refresh>Actualiser le résultat</button></div><div class="table-wrap"><table><thead><tr><th>Appliquer</th><th>Commande</th><th>Pays / canal</th><th>SKU de base</th><th>SKU de remplacement</th><th>Quantité remplacée</th><th>Quantité de remplacement</th><th>Stock disponible</th><th>Résultat</th></tr></thead><tbody></tbody></table></div><p data-selection></p><button type="button" class="primary" data-apply>Appliquer la sélection et reprendre les commandes</button><p>La reprise utilise le parcours habituel de Commandes et livraisons. Les contrôles de stock, de documents et d’étiquettes restent applicables. Un nouveau blocage est indiqué dans le résultat.</p></div></div>';
 document.querySelector('main').append(section);
 const feedback=section.querySelector('[data-feedback]'),apply=section.querySelector('[data-apply]'),selected=new Set(),known=new Set();
 let batchId=null,batch=null,timer=null,busy=false;
 const downloads=document.createElement('div');downloads.className='actions';
 const help=document.createElement('p');help.textContent='Exportez les lignes des commandes en rupture, choisissez les SKU dans l’onglet Équivalents proposés, puis complétez Onglet type. Supprimez les lignes que vous ne souhaitez pas remplacer. Consultez Contrôles pour les commandes non vérifiées ou exclues. Aucun remplacement au téléchargement.';
 section.querySelector('form').before(downloads,help);
 for(const [path,label] of [['template','Télécharger le modèle Excel'],['shortages','Exporter les ruptures et équivalents']]){
  const button=document.createElement('button');button.type='button';button.textContent=label;downloads.append(button);
  button.onclick=async()=>{
   const buttons=[...downloads.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);feedback.textContent=path==='shortages'?'Lecture des commandes et des stocks Erplain… Cette vérification peut prendre plusieurs minutes.':'Préparation du modèle…';
   try{
    let result=await api('/api/equivalence-import/'+path);
    if(result.id){const id=result.id;while(result.status==='checking'){await new Promise(resolve=>setTimeout(resolve,2000));result=await api('/api/equivalence-import/export?id='+encodeURIComponent(id));}if(result.status==='failed')throw Error(result.error);}
    const bytes=Uint8Array.from(atob(result.file),c=>c.charCodeAt(0));
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})),link=document.createElement('a');link.href=url;link.download=result.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    feedback.textContent=path==='shortages'?result.rows+' ligne(s) en rupture exportée(s). '+result.unverified+' commande(s) non vérifiable(s) : consultez Contrôles dans le fichier.':'Modèle téléchargé : remplissez Onglet type puis analysez le fichier.';
   }catch(e){feedback.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}
  };
 }
 const history=document.createElement('select');history.setAttribute('aria-label','Reprendre un import récent');history.append(new Option('Imports récents…',''));section.querySelector('form').after(history);
 async function loadHistory(){const h=await api('/api/equivalence-import/history');history.replaceChildren(new Option('Imports récents…',''));for(const r of h.rows)history.append(new Option(new Date(r.created_at).toLocaleString('fr-FR')+' · '+r.status,r.id));if(batchId)history.value=batchId;}
 history.onchange=()=>{if(!history.value)return;batchId=history.value;selected.clear();known.clear();clearTimeout(timer);refresh();};
 const labels={checking:'Vérification en cours',valid:'Applicable',blocked:'Bloquée',already:'Déjà appliquée',queued:'En attente',processing:'Traitement en cours',applied:'Remplacement vérifié',skipped:'Décochée'};
 function selection(){section.querySelector('[data-selection]').textContent=selected.size+' ligne(s) sélectionnée(s)';apply.disabled=busy||batch?.status!=='ready'||!selected.size;}
 function render(){
  section.querySelector('[data-preview]').hidden=false;const tbody=section.querySelector('tbody');tbody.replaceChildren();
  for(const r of batch.rows){if(r.status==='valid'&&!known.has(r.line)){selected.add(r.line);known.add(r.line);}if(r.status!=='valid')selected.delete(r.line);
   const tr=document.createElement('tr'),td=document.createElement('td'),check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label','Appliquer la ligne '+r.line+' de '+r.reference);check.checked=selected.has(r.line);check.disabled=r.status!=='valid'||batch.status!=='ready'||busy;
   check.onchange=()=>{check.checked?selected.add(r.line):selected.delete(r.line);selection();};td.append(check);tr.append(td);
   const result=r.error||r.job?.error||r.job?.stage||labels[r.status]||r.status;
   for(const value of [r.reference,[r.country,r.channel].filter(Boolean).join(' · '),r.sku,r.replacementSku,r.replaceQuantity??'—',r.replacementQuantity??'—',r.available??'—',result]){const cell=document.createElement('td');cell.textContent=String(value);tr.append(cell);}tbody.append(tr);
  }
  const counts={};for(const r of batch.rows)counts[r.status]=(counts[r.status]||0)+1;
  feedback.textContent=batch.status==='checking'?'Analyse et lecture du stock Erplain : '+batch.rows.filter(r=>r.status!=='checking').length+' / '+batch.rows.length+' lignes examinées…':batch.status==='ready'?'Analyse terminée : '+(counts.valid||0)+' applicable(s), '+(counts.blocked||0)+' bloquée(s), '+(counts.already||0)+' déjà appliquée(s).':batch.status==='applying'?'Remplacements et reprise des commandes en cours…':'Traitement terminé : '+(counts.applied||0)+' remplacement(s) vérifié(s), '+(counts.blocked||0)+' ligne(s) à vérifier. Consultez les résultats et Commandes et livraisons.';
  selection();
 }
 async function refresh(){if(!batchId)return;try{batch=await api('/api/equivalence-import?id='+encodeURIComponent(batchId));render();if(['checking','applying'].includes(batch.status)&&!section.hidden)timer=setTimeout(refresh,2500);}catch(e){feedback.textContent=e.message;}}
 nav.onclick=async()=>{await show('equivalence-import');$('title').textContent='Importer des équivalences';clearTimeout(timer);try{await loadHistory();await refresh();}catch(e){feedback.textContent=e.message;}};
 section.querySelector('[data-all]').onclick=()=>{if(batch?.status==='ready')for(const r of batch.rows)if(r.status==='valid')selected.add(r.line);render();};
 section.querySelector('[data-none]').onclick=()=>{selected.clear();render();};
 section.querySelector('[data-refresh]').onclick=()=>{clearTimeout(timer);refresh();};
 section.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const file=section.querySelector('input[type=file]').files[0];if(!file)return;
  if(file.size>10*1024*1024){feedback.textContent='Le fichier doit faire moins de 10 Mo.';return;}
  const button=event.currentTarget.querySelector('button');button.disabled=true;feedback.textContent='Lecture du fichier…';
  try{const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));const result=await api('/api/equivalence-import/analyze',{file:btoa(raw)});clearTimeout(timer);batchId=result.id;selected.clear();known.clear();await loadHistory();await refresh();}catch(e){feedback.textContent=e.message;}finally{button.disabled=false;}
 };
 apply.onclick=async()=>{
  if(busy||batch?.status!=='ready'||!selected.size)return;busy=true;render();feedback.textContent='Enregistrement de la sélection…';
  try{batch=await api('/api/equivalence-import/apply',{id:batchId,lines:[...selected].sort((a,b)=>a-b)});render();clearTimeout(timer);timer=setTimeout(refresh,1000);}catch(e){feedback.textContent=e.message;}finally{busy=false;selection();}
 };
})();
