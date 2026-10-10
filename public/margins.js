(()=>{
const money=v=>Number.isFinite(v)?v.toLocaleString('fr-FR',{style:'currency',currency:'EUR'}):'—',pct=v=>Number.isFinite(v)?(v*100).toLocaleString('fr-FR',{maximumFractionDigits:1})+' %':'—';let data=null,busy=false,loadError=null;
const dialog=document.createElement('dialog');dialog.id='margin-detail-dialog';dialog.setAttribute('aria-label','Détail de la marge');dialog.innerHTML='<header><h2>Détail de la marge</h2><button data-close-margin>Fermer</button></header><div hidden><input id="margin-search"><select id="margin-filter"><option value="all">Toutes</option></select></div><button id="margin-refresh">Actualiser le calcul</button><p id="margin-state" role="status"></p><div id="margin-results"></div><p id="margin-source"></p>';document.body.append(dialog);
dialog.querySelector('[data-close-margin]').onclick=()=>dialog.close();
let focusedOrder=null;
function openMargin(id){focusedOrder=id;render();if(!dialog.open)dialog.showModal();}

function render(){if(!data)return;const q=$('margin-search').value.trim().toLowerCase(),filter=$('margin-filter').value;const rows=data.rows.filter(r=>r.id===focusedOrder);$('margin-state').textContent=rows[0]?.status==='incomplete'?'Données à compléter pour cette commande':'Estimation selon le calculateur publié';$('margin-source').textContent='Référentiel publié du '+new Date(data.source.capturedAt).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})+' · version '+data.source.version.slice(0,12)+' · calcul du '+new Date(data.calculatedAt).toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris'});$('margin-results').innerHTML=rows.map(r=>`<details class="margin-card" open><summary><strong>${esc(r.reference)} · ${esc(r.channel)}</strong> — <span class="${r.status==='negative'?'margin-negative':''}">${r.status==='incomplete'?'Marge à compléter':money(r.profit)+' HT'}</span> · Bénéfice / recettes totales HT : ${pct(r.margin)} · Bénéfice / coûts HT après contribution : ${pct(r.markup)}</summary>${r.issues.length?'<p>'+r.issues.map(esc).join('<br>')+'</p>':''}<p>Recettes HT : ${money(r.totalReceipts)} (dont contribution ${money(r.credit)}) · Achats : ${money(r.purchase)} · Transport fournisseur : ${money(r.supplierShipping)} · Livraison : ${money(r.shipping)} · Commissions : ${money(r.fees)} · Autres coûts : ${money(r.other)}</p><p>${esc(r.shippingSource||'')}<br>${esc(r.creditSource||'')}</p><div class="table-wrap"><table><thead><tr><th>SKU / produit</th><th>Quantité</th><th>Résultat HT de la ligne</th><th>À vérifier</th></tr></thead><tbody>${r.lines.map(l=>`<tr><td>${esc(l.sku)}<br>${esc(l.product||'')}</td><td>${l.quantity??'—'}</td><td class="${l.profit<0?'margin-negative':''}">${money(l.profit)}</td><td>${l.issues.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div><p>${(r.warnings||[]).map(esc).join('<br>')}</p><button data-margin-order="${esc(r.id)}">Ouvrir la commande pour vérification</button></details>`).join('')||'<p>Aucune commande pour ce filtre.</p>';for(const b of $('margin-results').querySelectorAll('[data-margin-order]'))b.onclick=()=>{dialog.close();orderDetail(b.dataset.marginOrder);};}
function positionCountryMargins(){
 const table=$('order-rows').closest('table'),header=table?.tHead?.rows[0];if(!header)return;
 table.classList.add('orders-with-margins');
 if(!header.querySelector('[data-column="country-margin"]')){const th=document.createElement('th');th.dataset.column='country-margin';th.textContent='Pays / marge';header.append(th);}
 for(const row of $('order-rows').rows){const ref=row.querySelector('[data-detail],[data-delivery-detail]');if(!ref){const cell=row.querySelector('td[colspan]');if(cell&&cell.colSpan!==header.cells.length)cell.colSpan=header.cells.length;continue;}
 let cell=row.querySelector('[data-country-margin]');if(!cell){cell=row.insertCell();cell.dataset.countryMargin='';}
 const country=ref.parentElement.querySelector('.order-country');if(country)cell.prepend(country);
 const chip=ref.parentElement.querySelector('[data-margin-chip]');if(chip)cell.append(chip);
 }
}
function paintMarginChip(target,r,id){
 let chip=target.querySelector('[data-margin-chip]');
 if(!r){if(chip)chip.remove();const text=loadError?'Marge indisponible · actualisez la liste':data?'Marge à compléter':'Chargement de la marge…';if(target.textContent!==text)target.textContent=text;return;}
 const label=r.status==='incomplete'?'Marge à compléter':(r.profit>0?'+':'')+money(r.profit)+'\nRecettes : '+pct(r.margin)+'\nCoûts nets : '+pct(r.markup);
 if(!chip){chip=document.createElement('button');chip.dataset.marginChip='';if(target.hasAttribute('data-temu-margin'))target.textContent='';target.append(chip);chip.onclick=()=>openMargin(id);}
 if(chip.textContent!==label)chip.textContent=label;
 const hint=(loadError?'Calcul non actualisé. ':'')+(r.status==='incomplete'?'Consulter les données à compléter':'Bénéfice / recettes totales HT : '+pct(r.margin)+' — Bénéfice / coûts HT après contribution : '+pct(r.markup)+' — Cliquer pour le détail');
 if(chip.title!==hint)chip.title=hint;
 const cls='margin-chip '+(r.status==='negative'?'margin-negative':r.status==='positive'?'margin-positive':r.status==='zero'?'margin-zero':'margin-warning');if(chip.className!==cls)chip.className=cls;
}
function temuBadges(){const byId=new Map((data?.rows||[]).map(r=>[r.id,r]));for(const target of document.querySelectorAll('[data-temu-margin]'))paintMarginChip(target,byId.get(target.dataset.temuMargin),target.dataset.temuMargin);}
function badges(){positionCountryMargins();if(data){const byId=new Map(data.rows.map(r=>[r.id,r]));for(const b of document.querySelectorAll('#order-rows [data-detail]')){const target=b.closest('tr').querySelector('[data-country-margin]')||b.parentElement;const r=byId.get(b.dataset.detail);if(!r){target.querySelector('[data-margin-chip]')?.remove();continue;}paintMarginChip(target,r,b.dataset.detail);}}temuBadges();}
async function refresh(){if(busy)return;busy=true;$('margin-refresh').disabled=true;$('margin-state').textContent='Lecture des commandes et calcul des marges…';try{const latest=await api('/api/margins');if(!Array.isArray(latest?.rows))throw Error('Réponse du calcul des marges invalide');data=latest;loadError=null;render();badges();}catch(e){loadError=e.message;$('margin-state').textContent=e.message;temuBadges();}finally{window.dispatchEvent(new Event('v3-margins-updated'));busy=false;$('margin-refresh').disabled=false;}}
window.V3Margins={refresh,paintTemu:temuBadges,row:id=>loadError?null:data?.rows.find(r=>r.id===id)};
$('margin-refresh').onclick=refresh;$('margin-filter').onchange=render;$('margin-search').oninput=render;
new MutationObserver(badges).observe($('order-rows'),{childList:true,subtree:true});
setInterval(()=>{if(user&&!document.hidden&&(currentView==='orders'||currentView==='temu'||dialog.open))refresh();},60000);const ready=setInterval(()=>{if(user){clearInterval(ready);refresh();}},1500);
})();
