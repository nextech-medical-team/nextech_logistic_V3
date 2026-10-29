(()=>{
const money=v=>Number.isFinite(v)?v.toLocaleString('fr-FR',{style:'currency',currency:'EUR'}):'—',pct=v=>Number.isFinite(v)?(v*100).toLocaleString('fr-FR',{maximumFractionDigits:1})+' %':'—';let data=null,busy=false,loadError=null;
const dialog=document.createElement('dialog');dialog.id='margin-detail-dialog';dialog.setAttribute('aria-label','Détail de la marge');dialog.innerHTML='<header><h2>Détail de la marge</h2><button data-close-margin>Fermer</button></header><div hidden><input id="margin-search"><select id="margin-filter"><option value="all">Toutes</option></select></div><button id="margin-refresh">Actualiser le calcul</button><p id="margin-state" role="status"></p><div id="margin-results"></div><p id="margin-source"></p>';document.body.append(dialog);
dialog.querySelector('[data-close-margin]').onclick=()=>dialog.close();
let focusedOrder=null;
function openMargin(id){focusedOrder=id;render();if(!dialog.open)dialog.showModal();}

function comparisonTitle(s,calculator=false){return calculator?'Calculateur (prévision)':s?.basis==='label'?'Étiquette TEMU':s?.basis==='quote'?'Devis TEMU'+(s.stale?' expiré':''):'Devis TEMU absent';}
function comparisonDetails(r){if(!r.calculatorMargin)return '';const scenarios=[[r.calculatorMargin,true],[r.temuMargin,false]];return '<section class="margin-comparison-detail"><h3>Calculateur et transport TEMU</h3><div class="table-wrap"><table><thead><tr><th>Base de calcul</th><th>Bénéfice HT</th><th>Transport HT</th><th>Tarif utilisé</th></tr></thead><tbody>'+scenarios.map(([s,calc])=>'<tr><th>'+esc(comparisonTitle(s,calc))+'</th><td>'+esc(s?.status==='incomplete'?'À compléter':money(s?.profit))+'</td><td>'+esc(money(s?.shipping))+'</td><td>'+esc(s?.shippingSource||s?.issues?.join(' ; ')||'Indisponible')+'</td></tr>').join('')+'</tbody></table></div><p>Les recettes et coûts produits sont identiques dans les deux calculs. Le tarif du calculateur est une prévision ; sa disponibilité dans TEMU n’est pas garantie.</p>'+(r.temuMargin?.stale?'<p>Le devis TEMU est expiré : le résultat associé est une estimation à actualiser avant achat.</p>':'')+'</section>';}
function render(){if(!data)return;const q=$('margin-search').value.trim().toLowerCase(),filter=$('margin-filter').value;const rows=data.rows.filter(r=>r.id===focusedOrder);$('margin-state').textContent=rows[0]?.calculatorMargin?'Comparaison : calculateur et transport TEMU':rows[0]?.status==='incomplete'?'Données à compléter pour cette commande':'Estimation selon le calculateur publié';$('margin-source').textContent=data.available===false?data.reason:'Référentiel publié du '+new Date(data.source.capturedAt).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})+' · version '+data.source.version.slice(0,12)+' · calcul du '+new Date(data.calculatedAt).toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris'});$('margin-results').innerHTML=rows.map(r=>`${comparisonDetails(r)}<details class="margin-card" open><summary><strong>${esc(r.reference)} · ${esc(r.channel)}</strong> — <span class="${r.status==='negative'?'margin-negative':''}">${r.status==='incomplete'?'Marge à compléter':money(r.profit)+' HT'}</span> · Bénéfice / recettes totales HT : ${pct(r.margin)} · Bénéfice / coûts HT après contribution : ${pct(r.markup)}</summary>${r.issues.length?'<p>'+r.issues.map(esc).join('<br>')+'</p>':''}<p>Recettes HT : ${money(r.totalReceipts)} (dont contribution ${money(r.credit)}) · Achats : ${money(r.purchase)} · Transport fournisseur : ${money(r.supplierShipping)} · Livraison : ${money(r.shipping)} · Commissions : ${money(r.fees)} · Autres coûts : ${money(r.other)}</p><p>${esc(r.shippingSource||'')}<br>${esc(r.creditSource||'')}</p><div class="table-wrap"><table><thead><tr><th>SKU / produit</th><th>Quantité</th><th>Résultat HT de la ligne</th><th>À vérifier</th></tr></thead><tbody>${r.lines.map(l=>`<tr><td>${esc(l.sku)}<br>${esc(l.product||'')}</td><td>${l.quantity??'—'}</td><td class="${l.profit<0?'margin-negative':''}">${money(l.profit)}</td><td>${l.issues.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div><p>${(r.warnings||[]).map(esc).join('<br>')}</p><button data-margin-order="${esc(r.id)}">Ouvrir la commande pour vérification</button></details>`).join('')||'<p>Aucune commande pour ce filtre.</p>';for(const b of $('margin-results').querySelectorAll('[data-margin-order]'))b.onclick=()=>{dialog.close();orderDetail(b.dataset.marginOrder);};}
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
 // This painter also runs from a subtree observer. Rewriting identical text
 // would enqueue itself forever and starve input, timers and browser paints.
 let empty=target.querySelector('[data-margin-empty]');
 if(target.closest('tr')?.dataset.orderDelivered==='true'&&(!r||r.status==='incomplete')){
  chip?.remove();
  if(!empty){empty=document.createElement('span');empty.dataset.marginEmpty='';empty.textContent='—';if(target.hasAttribute('data-temu-margin'))target.replaceChildren(empty);else target.append(empty);}
  return;
 }
 empty?.remove();
 if(!r){if(chip)chip.remove();const text=loadError?'Marge indisponible · actualisez la liste':data?'Marge à compléter':'Chargement de la marge…';if(target.textContent!==text)target.textContent=text;return;}
 const comparison=!!r.calculatorMargin;
 const label=r.status==='incomplete'?'Marge à compléter':(r.profit>0?'+':'')+money(r.profit)+'\nRecettes : '+pct(r.margin)+'\nCoûts nets : '+pct(r.markup);
 const comparisonHtml=comparison?[[r.calculatorMargin,true],[r.temuMargin,false]].map(([scenario,calc])=>'<span class="margin-comparison-value '+(scenario?.status==='positive'?'is-positive':scenario?.status==='negative'?'is-negative':'')+'">'+esc(comparisonTitle(scenario,calc))+' : '+esc(scenario?.status==='incomplete'?'à compléter':(scenario?.profit>0?'+':'')+money(scenario?.profit))+'</span>').join(''):null;
 if(!chip){chip=document.createElement('button');chip.dataset.marginChip='';if(target.hasAttribute('data-temu-margin'))target.textContent='';target.append(chip);chip.onclick=()=>openMargin(id);}
 if(comparison){if(chip.innerHTML!==comparisonHtml)chip.innerHTML=comparisonHtml;}else if(chip.textContent!==label)chip.textContent=label;
 const hint=(loadError?'Calcul non actualisé. ':'')+(r.status==='incomplete'?'Consulter les données à compléter':'Bénéfice / recettes totales HT : '+pct(r.margin)+' — Bénéfice / coûts HT après contribution : '+pct(r.markup)+' — Cliquer pour le détail');
 const displayHint=comparison?'Comparaison des bénéfices HT : grille du calculateur et coût proposé par TEMU. Cliquer pour les tarifs et le détail.':hint;
 if(chip.title!==displayHint)chip.title=displayHint;
 const cls='margin-chip '+(comparison?'margin-comparison':r.status==='negative'?'margin-negative':r.status==='positive'?'margin-positive':r.status==='zero'?'margin-zero':'margin-warning');if(chip.className!==cls)chip.className=cls;
}
function temuBadges(){const byId=new Map((data?.rows||[]).map(r=>[r.id,r]));for(const target of document.querySelectorAll('[data-temu-margin]'))paintMarginChip(target,byId.get(target.dataset.temuMargin),target.dataset.temuMargin);}
function badges(){positionCountryMargins();if(data){const byId=new Map(data.rows.map(r=>[r.id,r]));for(const b of document.querySelectorAll('#order-rows [data-detail]')){const target=b.closest('tr').querySelector('[data-country-margin]')||b.parentElement;const r=byId.get(b.dataset.detail);if(!r){target.querySelector('[data-margin-chip]')?.remove();continue;}paintMarginChip(target,r,b.dataset.detail);}}temuBadges();}
async function refresh(){if(busy)return;busy=true;$('margin-refresh').disabled=true;$('margin-state').textContent='Lecture des commandes et calcul des marges…';try{const latest=await api('/api/margins');if(!Array.isArray(latest?.rows))throw Error('Réponse du calcul des marges invalide');data=latest;loadError=null;render();badges();}catch(e){loadError=e.message;$('margin-state').textContent=displayErrorMessage(e);temuBadges();}finally{window.dispatchEvent(new Event('v3-margins-updated'));busy=false;$('margin-refresh').disabled=false;}}
window.V3Margins={refresh,paintTemu:temuBadges,row:id=>loadError?null:data?.rows.find(r=>r.id===id)};
$('margin-refresh').onclick=refresh;$('margin-filter').onchange=render;$('margin-search').oninput=render;
// Processing clocks and stock readouts change independently of margins. Only
// structural changes to the references/country/margin hosts need repainting.
const marginNodes='[data-detail],[data-delivery-detail],.order-country,[data-country-margin],[data-margin-chip],[data-temu-margin]';
function touchesMargins(node){return node.nodeType===1&&(node.matches(marginNodes)||!!node.querySelector(marginNodes));}
new MutationObserver(records=>{if(records.some(r=>r.target===$('order-rows')||[...r.addedNodes,...r.removedNodes].some(touchesMargins)))badges();}).observe($('order-rows'),{childList:true,subtree:true});
setInterval(()=>{if(user&&!document.hidden&&(currentView==='orders'||currentView==='temu'||dialog.open))refresh();},60000);const ready=setInterval(()=>{if(user){clearInterval(ready);refresh();}},1500);
})();
