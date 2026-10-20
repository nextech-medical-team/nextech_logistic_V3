(()=>{
 const kind=$('import-kind'),file=$('import-file'),form=$('import-form');if(!kind||!file||!form)return;
 kind.add(new Option('Commandes TEMU · Excel multi-pays','temu_excel'));
 const panel=document.createElement('section');panel.hidden=true;panel.id='temu-excel-preview';
 panel.innerHTML=`<h3>Vérifier l’import TEMU</h3>
 <p>Sélectionnez les nouvelles commandes, puis confirmez l’import et la préparation des BC/BL. Après validation du BL et du stock, l’achat est automatique si la marge est positive et le transporteur admissible ; sinon, utilisez le bouton d’achat manuel.</p>
 <p data-summary role="status"></p><div class="table-wrap"><table><thead><tr><th>Pays</th><th>Commandes</th><th>Nouvelles valides</th><th>Déjà présentes</th><th>À corriger</th></tr></thead><tbody data-countries></tbody></table></div>
 <details><summary>Fichiers analysés et erreurs</summary><div data-files></div><ul data-errors></ul></details>
 <div class="actions"><button type="button" data-new>Sélectionner les nouvelles commandes valides</button><button type="button" data-none>Tout désélectionner</button><button type="button" data-report>Télécharger le rapport</button></div>
 <p data-selection></p><div class="table-wrap"><table><thead><tr><th>Importer</th><th>Commande</th><th>Pays</th><th>Destinataire</th><th>Lignes / quantité</th><th>Situation</th></tr></thead><tbody data-orders></tbody></table></div>
 <div class="pagination"><button type="button" data-prev>Précédent</button><span data-page></span><button type="button" data-next>Suivant</button></div>
 <button type="button" class="primary" data-confirm>Importer et préparer les commandes sélectionnées</button><button type="button" data-cancel>Annuler</button><p data-result role="status"></p>`;
 $('import-preview').after(panel);
 const find=s=>panel.querySelector(s),chosen=new Set();
 const hint=document.createElement('p');hint.hidden=true;hint.textContent='Sélectionnez un ou plusieurs Excel TEMU, jusqu’à 50 fichiers et 12 Mo au total. Le pays est lu dans chaque fichier.';file.closest('.form-grid').after(hint);
 const style=document.createElement('style');style.textContent='.temu-excel-form .form-grid{align-items:start}.temu-excel-form .form-grid label{min-width:0}.temu-excel-form input,.temu-excel-form select{min-width:0;max-width:100%;width:100%}#temu-excel-preview input[type=checkbox]{width:auto}#temu-excel-preview .actions{display:flex;flex-wrap:wrap;gap:8px}';document.head.append(style);
 const generalHint=document.querySelector('#view-imports .hint-box p'),originalHint=generalHint?.textContent;
 const originalSubmit=form.onsubmit,originalAccept=file.accept,originalButton=$('import-button').textContent;
 let draft=null,preview=null,result=null,page=1,busy=false,lastKind=kind.value;
 const preparation=new Map();
 function reset(){preparation.clear();draft=null;preview=null;result=null;chosen.clear();page=1;panel.hidden=true;find('[data-result]').textContent='';}
 function setBusy(value){busy=value;kind.disabled=value;file.disabled=value;$('import-button').disabled=value;panel.querySelectorAll('button,input,select').forEach(e=>e.disabled=value);if(!value&&preview)render();}
 function configure(){
  const active=kind.value==='temu_excel';
  if(lastKind!==kind.value){file.value='';reset();$('import-result').textContent='';lastKind=kind.value;}
  file.multiple=active;file.accept=active||kind.value==='purchases'?'.xlsx':originalAccept;hint.hidden=!active;form.classList.toggle('temu-excel-form',active);
  if(generalHint)generalHint.textContent=active?'Après analyse, sélectionnez les nouvelles commandes et confirmez leur import avec préparation des BC/BL. Les étiquettes à marge positive suivent ensuite le parcours d’achat automatique.':originalHint;
  $('import-button').textContent=active?'Analyser les fichiers':originalButton;
 }
 kind.addEventListener('change',configure);file.addEventListener('change',reset);configure();
 const previousShow=show;show=async function(view){if(view==='imports')configure();return previousShow(view);};
 const country=c=>c||'À vérifier';
 function render(){
  if(!preview)return;
  const pages=Math.max(1,Math.ceil(preview.orders.length/100));page=Math.min(page,pages);
  find('[data-selection]').textContent=chosen.size+' commande(s) sélectionnée(s)';
  find('[data-page]').textContent=`Page ${page} / ${pages}`;
  find('[data-prev]').disabled=busy||page<=1;find('[data-next]').disabled=busy||page>=pages;
  const remaining=result?result.results.filter(r=>r.status==='created'&&preparation.get(r.reference)?.status!=='prepared'):[];
  find('[data-confirm]').textContent=result?(remaining.length?'Reprendre les préparations restantes ('+remaining.length+')':'Traitement de la sélection terminé'):'Importer et préparer les commandes sélectionnées';
  find('[data-confirm]').disabled=busy||!draft||(result?!remaining.length:!chosen.size);
  find('[data-new]').disabled=busy||!draft||!!result;find('[data-none]').disabled=busy||!draft||!!result;
  find('[data-orders]').innerHTML=preview.orders.slice((page-1)*100,page*100).map(o=>`<tr><td><input type="checkbox" data-reference="${esc(o.reference)}" aria-label="Importer ${esc(o.reference)}" ${chosen.has(o.reference)?'checked':''} ${busy||!draft||result||!o.eligible?'disabled':''}></td><td>${esc(o.reference)}</td><td>${esc(country(o.country))}</td><td>${esc(o.recipient)}</td><td>${o.lines} / ${o.quantity}</td><td>${esc(o.issues.length?o.issues.map(e=>displayErrorMessage(e,'TEMU')).join(' ; '):o.duplicate?'Déjà présente — ignorée':'Nouvelle commande')}</td></tr>`).join('');
 }
 find('[data-orders]').onchange=e=>{const ref=e.target.dataset.reference;if(!ref||busy||!draft||result)return;e.target.checked?chosen.add(ref):chosen.delete(ref);render();};
 find('[data-new]').onclick=()=>{chosen.clear();for(const o of preview.orders)if(o.eligible)chosen.add(o.reference);render();};
 find('[data-none]').onclick=()=>{chosen.clear();render();};
 find('[data-prev]').onclick=()=>{page--;render();};find('[data-next]').onclick=()=>{page++;render();};
 find('[data-cancel]').onclick=()=>{reset();$('import-result').textContent='Aperçu TEMU fermé.';};
 form.onsubmit=async e=>{
  if(kind.value!=='temu_excel')return originalSubmit(e);
  e.preventDefault();if(busy)return;reset();clearImportPreview();
  const files=[...file.files];
  if(!files.length){$('import-result').textContent='Choisissez au moins un fichier Excel TEMU.';return;}
  if(files.length>50||files.some(f=>!f.name.toLowerCase().endsWith('.xlsx'))||files.reduce((n,f)=>n+f.size,0)>12*1024*1024){$('import-result').textContent='Sélectionnez de 1 à 50 fichiers XLSX, limités à 12 Mo au total.';return;}
  setBusy(true);$('import-result').textContent='Analyse des fichiers TEMU…';
  try{
   const input=[];
   for(const f of files){const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));input.push({filename:f.name,content:btoa(binary)});}
   preview=await api('/api/import/temu/preview',{files:input});
   draft={files:input,hash:preview.hash,requestId:crypto.randomUUID()};
   for(const o of preview.orders)if(o.eligible)chosen.add(o.reference);
   find('[data-summary]').textContent=`${preview.files.length} fichier(s) · ${preview.orders.length} commandes · ${preview.newCount} nouvelles valides · ${preview.duplicateCount} déjà présentes · ${preview.errors.length} erreurs · ${preview.repeatedLines} lignes répétées ignorées`;
   find('[data-countries]').innerHTML=preview.countries.map(c=>`<tr><td>${esc(c.country)}</td><td>${c.total}</td><td>${c.newCount}</td><td>${c.duplicateCount}</td><td>${c.errorCount}</td></tr>`).join('');
   find('[data-files]').innerHTML=preview.files.map(f=>`<p>${esc(f.filename)} : ${f.orders} commandes, ${f.rows} lignes${f.error?' — '+errorDetailsHtml(f.error,'TEMU'):''}</p>`).join('');
   find('[data-errors]').innerHTML=preview.errors.map(r=>`<li>${esc(r.filename)}${r.row?' · ligne '+r.row:''}${r.reference?' · '+esc(r.reference):''} : ${esc(r.message)}</li>`).join('');
   $('import-result').textContent='Analyse terminée. Vérifiez l’aperçu avant de confirmer.';panel.hidden=false;
  }catch(error){$('import-result').textContent=displayErrorMessage(error);}finally{setBusy(false);}
 };
 find('[data-confirm]').onclick=async()=>{
  if(busy||!draft||!chosen.size)return;
  setBusy(true);find('[data-result]').textContent='Enregistrement et préparation des commandes sélectionnées…';
  try{
   if(!result){result=await api('/api/import/temu/confirm',{...draft,selection:[...chosen],prepare:true});}
   const created=result.results.filter(r=>r.status==='created');
   for(let i=0;i<created.length;i++){
    const row=created[i];if(preparation.get(row.reference)?.status==='prepared')continue;
    find('[data-result]').textContent=`Vérification TEMU et préparation ${i+1} / ${created.length} · ${row.reference}…`;
    try{
     const p=await api('/api/temu/excel/preview?'+new URLSearchParams({reference:row.reference}));
     await api('/api/temu/excel/prepare',{reference:row.reference,fingerprint:p.fingerprint,confirmPreparation:true});
     preparation.set(row.reference,{status:'prepared',message:'Préparation BC/BL demandée'});
    }catch(e){preparation.set(row.reference,{status:'held',message:e.message});}
   }
   const prepared=created.filter(r=>preparation.get(r.reference)?.status==='prepared').length,held=created.length-prepared;
   find('[data-result]').textContent=`${created.length} commande(s) importée(s) · ${prepared} préparation(s) BC/BL demandée(s) · ${held} à vérifier · ${result.skipped} déjà présente(s) ignorée(s). L’achat automatique dépend de la validation du BL, du stock et de la marge.`+(held?' '+created.filter(r=>preparation.get(r.reference)?.status==='held').map(r=>r.reference+' : '+preparation.get(r.reference).message).join(' ; '):'');
   if(!held){draft=null;chosen.clear();}
   window.dispatchEvent(new Event('temu-excel-imported'));
   await stats().catch(()=>{});
  }catch(error){find('[data-result]').textContent=displayErrorMessage(error);}finally{setBusy(false);}
 };
 find('[data-report]').onclick=()=>{
  if(!preview)return;
  const lines=['Import TEMU Excel',...preview.countries.map(c=>`${c.country} : ${c.total} commandes, ${c.newCount} nouvelles valides, ${c.duplicateCount} déjà présentes, ${c.errorCount} à corriger`),
   ...preview.files.map(f=>`${f.filename} : ${f.rows} lignes, ${f.orders} commandes${f.error?' — '+f.error:''}`),
   ...preview.errors.map(e=>`${e.filename} · ${e.row||''} · ${e.reference||''} : ${e.message}`),
   ...(result?[result.message,...result.results.map(r=>`${r.reference} · ${r.country} · ${r.status==='created'?(preparation.get(r.reference)?.message||'Importée · préparation à reprendre'):'Ignorée : '+r.reason}`)]:['Analyse uniquement — import non confirmé',...preview.orders.map(o=>`${o.reference} · ${country(o.country)} · ${o.issues.length?o.issues.map(e=>displayErrorMessage(e,'TEMU')).join(' ; '):o.duplicate?'Déjà présente':'Nouvelle valide'}`)])];
  const url=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='rapport-import-temu.txt';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
})();
