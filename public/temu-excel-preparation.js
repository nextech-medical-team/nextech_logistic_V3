(()=>{
 const view=$('view-imports');if(!view)return;
 const panel=document.createElement('section');panel.className='panel padded';panel.id='temu-excel-preparation';
 panel.innerHTML=`<h2>Préparer les commandes Excel TEMU</h2><p>La commande est recherchée dans toutes les boutiques TEMU configurées lors du lancement des BC et BL dans Erplain. Après validation du BL et du stock, l’achat est automatique si la marge est positive et le transporteur admissible. Si la marge est à compléter, nulle ou négative, achetez l’étiquette manuellement depuis la commande en confirmant son prix. Colis : 0,25 kg, 10 × 8 × 0,5 cm et dernier créneau admissible.</p><button data-refresh>Actualiser les commandes Excel</button><p data-message role="status"></p><div class="table-wrap"><table><thead><tr><th>Commande</th><th>Pays</th><th>Avancement BC/BL</th><th>Actions</th></tr></thead><tbody></tbody></table></div><div data-preview></div>`;
 view.append(panel);const get=s=>panel.querySelector(s);let busy=false;
 async function load(){
  try{const result=await api('/api/temu/excel/orders');get('tbody').innerHTML=result.rows.map(o=>{
   const status=o.erp_error||o.resolution?.error||o.issue||(o.erp_live?.bl?.id?'BL créé · '+(o.erp_live.bl.status||'à vérifier'):o.resolution?.stage||o.erp_status||'À valider');
   return `<tr><td>${esc(o.reference)}</td><td>${esc(o.country)}</td><td>${esc(status)}</td><td>${!o.preparation?`<button data-verify="${esc(o.reference)}">Vérifier et préparer</button>`:`<button data-order="${esc(o.id)}">Voir la commande / corriger</button><button data-label="${esc(o.reference)}">Étiquette et marge TEMU</button>`}</td></tr>`;
  }).join('')||'<tr><td colspan="4">Aucune commande Excel TEMU importée.</td></tr>';}catch(e){get('[data-message]').textContent=e.message;}
 }
 get('[data-refresh]').onclick=()=>{if(!busy)load();};
 panel.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||busy)return;
  if(b.dataset.order){orderDetail(b.dataset.order);return;}
  if(b.dataset.label){temuOpenOrder(b.dataset.label).catch(e=>get('[data-message]').textContent=e.message);return;}
  if(!b.dataset.verify)return;
  busy=true;b.disabled=true;get('[data-message]').textContent='Vérification des montants Excel avant préparation…';get('[data-preview]').innerHTML='';
  try{
   const p=await api('/api/temu/excel/preview?'+new URLSearchParams({reference:b.dataset.verify}));
   const box=get('[data-preview]');box.innerHTML=`<h3>${esc(p.reference)}</h3><p>${p.lines.map(l=>esc(l.sku)+' × '+l.quantity).join(' ; ')}</p><p>Total BC : ${p.commercial.total.toFixed(2)} ${esc(p.commercial.currency)} · Taxes du rapport TEMU : ${p.commercial.tax.toFixed(2)}</p><p>La TVA du BC sera calculée avec la taxe Erplain correspondant au pays de livraison. Cette action vérifie les articles auprès de TEMU et lance la préparation réelle des BC/BL dans Erplain. Les correspondances SKU et le stock suivent les contrôles habituels.</p><label><input type="checkbox" data-consent> Je confirme la préparation de cette commande.</label><button data-start disabled>Lancer les BC/BL dans Erplain</button>`;
   const ready=()=>box.querySelector('[data-start]').disabled=busy||!box.querySelector('[data-consent]').checked;
   box.onchange=ready;
   box.querySelector('[data-start]').onclick=async()=>{
    if(busy)return;busy=true;ready();get('[data-message]').textContent='Contrôle API TEMU puis lancement de la préparation…';
    try{const result=await api('/api/temu/excel/prepare',{reference:p.reference,fingerprint:p.fingerprint,confirmPreparation:true});get('[data-message]').textContent=result.message;box.innerHTML='';await load();}
    catch(e){get('[data-message]').textContent=e.message;}finally{busy=false;if(box.querySelector('[data-start]'))ready();}
   };
   get('[data-message]').textContent='Vérifiez les informations puis confirmez la préparation.';
  }catch(e){get('[data-message]').textContent=e.message;}finally{busy=false;b.disabled=false;}
 });
 const previous=show;show=async function(name){const result=await previous(name);if(name==='imports')await load();return result;};
 window.addEventListener('temu-excel-imported',()=>load());
})();
