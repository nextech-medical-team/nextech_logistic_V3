(()=>{
const panel=document.createElement('section');panel.id='view-erplain-refresh';panel.className='view';panel.hidden=true;
panel.innerHTML=`<div class="panel padded"><h2>Commandes Erplain LIVE</h2><p>Récupérez un BC existant, vérifiez ses données, puis validez son entrée dans V3. La préparation est une action séparée.</p>
<form id="erplain-one-form"><label>Numéro du BC ou référence externe<input id="erplain-one-reference" maxlength="200" required placeholder="Exemple : O00000288"></label><button type="submit" class="primary" id="erplain-one-fetch">Récupérer cette commande depuis Erplain</button></form>
<p id="erplain-one-note" role="status" aria-live="polite"></p><div id="erplain-one-preview"></div>
<h3>Commandes récupérées dans V3</h3><form id="erplain-recovered-form"><label>Rechercher dans les commandes récupérées<input id="erplain-recovered-search" maxlength="200" placeholder="BC, référence ou client"></label><button type="submit">Rechercher dans les commandes récupérées</button></form>
<p>Cette recherche consulte les commandes présentes dans V3.</p><div id="erplain-recovered-rows" class="table-wrap"></div><div class="pagination"><button id="erplain-recovered-prev">Précédent</button><span id="erplain-recovered-pages"></span><button id="erplain-recovered-next">Suivant</button></div>
<details><summary>Connexion ERPLAIN LIVE</summary><div id="live-reference-summary"></div></details></div>`;
document.querySelector('.view').parentElement.append(panel);
const button=document.createElement('button');button.dataset.view='erplain-refresh';button.textContent='Commandes Erplain LIVE';document.querySelector('nav').append(button);button.onclick=()=>show('erplain-refresh');
const el=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v?new Date(v).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'Pas encore relu';
let page=1,busy=false,preview=null,listGeneration=0;
const note=(text,error=false)=>{el('erplain-one-note').textContent=error?displayErrorMessage(text):text;el('erplain-one-note').style.color=error?'#b42318':'';};
function setBusy(value){busy=value;el('erplain-one-fetch').disabled=value;for(const b of el('erplain-one-preview').querySelectorAll('button'))b.disabled=value;}
const post=(path,data)=>api('/api/erplain-refresh/'+path,{...data});
function documentHtml(d){
 const a=d.shipping_address||{},bls=d.shipping_orders?.data||[],lines=d.line_items||[];

 return `<dl><dt>BC Erplain</dt><dd>${esc(d.label)} · Identifiant ${esc(d.id)} · ${esc(d.status)}</dd><dt>Référence externe</dt><dd>${esc(d.external_reference||'Sans référence externe')}</dd><dt>Client Erplain</dt><dd>${esc(d.customer?.label||'Absent')} · ${esc(d.customer?.id||'')}</dd><dt>Gestionnaire de compte</dt><dd>${esc(d.account_representative?.label||'Non renseigné')}</dd><dt>Adresse de livraison</dt><dd>${esc([a.label,a.address_1,a.address_2,a.postal_code,a.city,a.country,a.phone].filter(Boolean).join(' · '))}</dd><dt>Montant BC</dt><dd>${esc(d.total)} ${esc(d.currency?.label)}</dd></dl>
 <div class="table-wrap"><table><thead><tr><th>Produit / SKU</th><th>Quantité</th><th>Prix unitaire</th><th>Stock / emplacement</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${esc(l.variant?.product?.label||l.label||l.description||'Ligne')}<br>${esc(l.variant?.sku||'Sans SKU')}${l.type==='shipping_cost'&&!l.variant?' · Frais de livraison (hors produits physiques)':''}</td><td>${esc(l.quantity)}</td><td>${esc(l.price)} ${esc(d.currency?.label)}</td><td>${esc(l.location?.id||'Absent')}<br>Disponible : ${esc(l.available??'Non reçu')} · Réservé : ${esc(l.reserved_quantity??'Non reçu')} · En stock : ${esc(l.on_hand??'Non reçu')}</td></tr>`).join('')}</tbody></table></div>
 <h4>BL associés</h4>${bls.length?`<ul>${bls.map(b=>`<li>${esc(b.label)} · Identifiant ${esc(b.id)} · ${esc(b.status)}</li>`).join('')}</ul>`:'<p>Aucun BL associé.</p>'}`;
}
function renderPreview(r){
 preview=r;const box=el('erplain-one-preview');
 if(r.notFound){box.replaceChildren();note('BC introuvable pour cette référence.');return;}
 if(r.selectionRequired){box.innerHTML=`<h3>Plusieurs BC correspondent : sélectionnez un seul BC</h3><div class="table-wrap"><table><thead><tr><th>BC / identifiant</th><th>Référence</th><th>Client</th><th>Action</th></tr></thead><tbody>${r.candidates.map(d=>`<tr><td>${esc(d.label)} · ${esc(d.id)}</td><td>${esc(d.external_reference)}</td><td>${esc(d.customer?.label)}</td><td><button data-erplain-select="${esc(d.id)}">Vérifier ce BC</button></td></tr>`).join('')}</tbody></table></div><button data-erplain-abandon>Abandonner</button>`;return;}
 const admission=r.admissionIssues||[],preparation=r.preparationIssues||[];
 const labels={label:'Numéro BC',external_reference:'Référence externe',dated_at:'Date',status:'Statut',total:'Montant',tax_type:'TVA',update_stock:'Politique de stock',currency:'Devise',customer:'Client',shipping_address:'Adresse',account_representative:'Gestionnaire',line_items:'Produits, quantités, prix ou stock',shipping_orders:'BL associés'};
 const changed=r.previousDocument?Object.keys({...r.previousDocument,...r.document}).filter(k=>JSON.stringify(r.previousDocument[k])!==JSON.stringify(r.document[k])):[];
 box.innerHTML=`<h3>${r.alreadyRecovered?'Commande déjà récupérée':'Vérifier le BC avant son entrée dans V3'}</h3><p>Dernière lecture Erplain : ${esc(date(r.readAt))}</p>${r.changed?`<p role="alert"><strong>Le BC a changé. Relisez les nouvelles données avant une nouvelle validation.</strong></p><p>Informations modifiées : ${esc(changed.map(k=>labels[k]||k).join(', '))}</p><details><summary>Données consultées précédemment</summary>${documentHtml(r.previousDocument)}</details>`:''}${documentHtml(r.document)}
 ${admission.length?`<h4>Admission bloquée</h4><ul>${admission.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`:''}
 ${preparation.length?`<h4>Points à résoudre avant préparation</h4><ul>${preparation.map(i=>`<li>${esc(i)}</li>`).join('')}</ul><p>La validation de l’entrée dans V3 ne résout pas ces blocages logistiques.</p>`:''}
 <div class="actions">${r.alreadyRecovered?`<button data-erplain-open="${esc(r.orderId)}">Voir la commande</button>${r.archived?'<span>Commande archivée : aucune réactivation automatique.</span>':''}`:`<button class="primary" data-erplain-approve ${admission.length?'disabled':''}>Valider l’entrée dans V3</button><button data-erplain-reread>Relire ce BC dans Erplain</button>`}<button data-erplain-abandon>Abandonner</button></div><p>Abandonner ne modifie pas le BC dans Erplain.</p>`;
}
async function lookup(reference,bcId){
 if(busy)return;reference=String(reference||'').trim();if(!reference){note('Saisissez un numéro de BC ou une référence externe.',true);return;}
 setBusy(true);note('Lecture du BC dans Erplain LIVE…');
 try{const r=await post('targeted-lookup',{reference,...(bcId?{bcId}: {})});renderPreview(r);if(!r.notFound)note(r.selectionRequired?'Sélectionnez le BC à vérifier.':'Lecture terminée.');}
 catch(e){preview=null;el('erplain-one-preview').replaceChildren();note(e,true);}finally{setBusy(false);if(preview?.admissionIssues?.length){const b=panel.querySelector('[data-erplain-approve]');if(b)b.disabled=true;}}
}
async function loadRecovered(){
 const generation=++listGeneration;
 const r=await api('/api/erplain-refresh/recovered-orders?'+new URLSearchParams({search:el('erplain-recovered-search').value.trim(),page}));if(generation!==listGeneration)return;
 el('erplain-recovered-pages').textContent=r.total+' commandes · page '+r.page+' / '+r.pages;el('erplain-recovered-prev').disabled=r.page<=1;el('erplain-recovered-next').disabled=r.page>=r.pages;
 el('erplain-recovered-rows').innerHTML=r.rows.length?`<table><thead><tr><th>BC / référence</th><th>Client</th><th>Admission / traitement</th><th>Dernière lecture Erplain</th><th>Actions</th></tr></thead><tbody>${r.rows.map(o=>{
 const approved=o.source_payload?.erplainValidation==='approved',problems=[...new Set([...(o.erplain_refresh?.issues||[]),...(o.preparationIssues||[]),o.issue].filter(Boolean))];
 const logistic=o.archived?'Archivée':o.busy?'Traitement en cours':o.has_label?'Étiquette existante · '+o.tracking_status:problems.length?'Préparation à vérifier':'Préparation à lancer';
 const bls=(o.erp_live?.bc?.shipping_orders?.data||[]).filter(b=>o.erp_live?.bc?.pendingScope?(o.erp_live.pendingBlIds||[]).map(String).includes(String(b.id)):b.status!=='cancelled');
 const partial=o.partial_mode||bls.length>1||(!o.erp_live?.bc?.pendingScope&&(bls.some(b=>['shipped','delivered'].includes(b.status))||(o.erp_live?.bc?.line_items||[]).some(l=>Number(l.shipped_quantity)>0)));
 return `<tr><td>${esc(o.erp_live?.bc?.label)}<br>${esc(o.reference)}</td><td>${esc(o.recipient)}</td><td>${approved?'Validée dans V3':'Validation requise'}<br>${esc(logistic)}${problems.length?`<ul>${problems.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`:''}</td><td>${esc(date(o.read_at))}</td><td><button data-erplain-open="${esc(o.id)}">Voir la commande</button><button data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bc">Actualiser le BC Erplain</button><button data-erplain-document-refresh="${esc(o.id)}" data-erplain-document-kind="bl">Actualiser les BL Erplain</button>${approved&&!o.archived&&!o.busy&&(partial||!o.has_label)?`<button data-erplain-${partial?'partial':'prepare'}="${esc(o.id)}">${partial?'Préparer une livraison partielle':'Préparer la commande'}</button>`:''}${!o.archived?`<button data-erplain-correct="${esc(o.id)}">Résoudre un problème</button>`:''}</td></tr>`;
 }).join('')}</tbody></table>`:'<p>Aucune commande récupérée ne correspond à cette recherche.</p>';
}
el('erplain-one-form').onsubmit=e=>{e.preventDefault();lookup(el('erplain-one-reference').value);};
document.addEventListener('erplain-documents-refreshed',()=>{if(currentView==='erplain-refresh')loadRecovered().catch(e=>note(e,true));});
el('erplain-recovered-form').onsubmit=e=>{e.preventDefault();page=1;loadRecovered().catch(e=>note(e,true));};
el('erplain-recovered-prev').onclick=()=>{page--;loadRecovered().catch(e=>note(e,true));};el('erplain-recovered-next').onclick=()=>{page++;loadRecovered().catch(e=>note(e,true));};
panel.addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b||busy)return;
 try{
  if(b.hasAttribute('data-erplain-abandon')){preview=null;el('erplain-one-preview').replaceChildren();note('Récupération abandonnée. Le BC Erplain est inchangé.');return;}
  if(b.dataset.erplainSelect)return await lookup(preview.reference,b.dataset.erplainSelect);
  if(b.dataset.erplainOpen)return await orderDetail(b.dataset.erplainOpen);
  if(b.dataset.erplainCorrect)return await openCorrection(b.dataset.erplainCorrect);
  if(b.dataset.erplainPartial)return await openPartial(b.dataset.erplainPartial);
  if(b.dataset.erplainPrepare){b.disabled=true;try{await refreshAndResumeOrder(b.dataset.erplainPrepare);}finally{await loadRecovered();}return;}
  if(b.hasAttribute('data-erplain-reread')){setBusy(true);renderPreview(await post('targeted-reread',{bcId:String(preview.document.id)}));note('BC relu. Vérifiez les données avant validation.');}
  if(b.hasAttribute('data-erplain-approve')){
   setBusy(true);const r=await post('manual-review/approve',{bcId:String(preview.document.id),reviewHash:preview.reviewHash,confirmed:true});
   if(r.changed){renderPreview(r);note('Le BC a changé : une nouvelle validation est nécessaire.',true);}
   else{preview={...preview,alreadyRecovered:true,orderId:r.orderId,archived:r.archived};renderPreview(preview);note(r.alreadyRecovered?'Commande déjà récupérée.':'Entrée dans V3 validée. La préparation reste à lancer.');page=1;await loadRecovered();await orders();}
  }
 }catch(e){note(e,true);}finally{setBusy(false);if(preview?.admissionIssues?.length){const approve=panel.querySelector('[data-erplain-approve]');if(approve)approve.disabled=true;}}
});
const before=show;show=async view=>{await before(view);if(view==='erplain-refresh'){
 await loadRecovered();try{const s=await api('/api/erplain/live-reference'),box=el('live-reference-summary');box.replaceChildren();const names={products:'Produits / variantes',stocks:'Stocks accessibles',suppliers:'Fournisseurs',taxes:'Codes TVA',currencies:'Devises',locations:'Emplacements'};for(const [key,v]of Object.entries(s.references||{})){const p=document.createElement('p');p.textContent=(names[key]||key)+' : accès vérifié · '+v.total;box.append(p);}}catch(e){el('live-reference-summary').textContent=displayErrorMessage(e);}
}};
})();
