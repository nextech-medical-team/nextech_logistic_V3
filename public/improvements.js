function orderPlacedDateView(value){
 const raw=String(value||'').trim(),iso=/^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
 let date=iso?iso[3]+'/'+iso[2]+'/'+iso[1].slice(2):raw||'Date non fournie',time='',title=raw;
 if(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)){
  const stamp=new Date(raw);
  if(Number.isFinite(stamp.getTime())){date=new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',day:'2-digit',month:'2-digit',year:'2-digit'}).format(stamp);time=new Intl.DateTimeFormat('fr-FR',{timeZone:'Europe/Paris',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(stamp);title='Commande passée le '+date+' à '+time+' · heure de Paris';}
 }else{
  const local=/^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{2,4})[T ,]+([0-2]\d:[0-5]\d)(?::[0-5]\d)?$/.exec(raw);
  if(local&&Number(local[2].slice(0,2))<24){date=iso?date:local[1];time=local[2];title='Heure de la source · fuseau non précisé';}
 }
 return {html:'<span style="white-space:nowrap">'+esc(date)+'</span><small style="display:block;'+(time?'white-space:nowrap;':'')+'">'+esc(time||'Heure non fournie')+'</small>',title:title||'Date et heure de passation non fournies'};
}
const batchLabels=document.createElement('button');batchLabels.textContent='Télécharger les étiquettes sélectionnées';batchLabels.id='download-all-labels';document.querySelector('#view-orders .batch').append(batchLabels);
const selectBeforeBatch=selection;selection=()=>{selectBeforeBatch();batchLabels.disabled=!selected.size;};batchLabels.disabled=true;
async function downloadMerged(ids,temuReferences=[],deliveryIds=[]){
 const modal=document.createElement('dialog');modal.style.cssText='max-width:760px;width:90vw;max-height:85vh;overflow:auto';modal.setAttribute('aria-label','Étiquettes de la sélection');
 modal.innerHTML='<h2>Étiquettes de la sélection</h2><p data-count></p><label>Organiser les commandes et leurs étiquettes <select data-sort><option value="selection">Ordre de la sélection</option><option value="date">Date de commande</option><option value="manager">Gestionnaire</option><option value="sku">SKU Erplain</option><option value="supplier">Fournisseur</option><option value="supplier_sku" selected>Fournisseur puis SKU Erplain</option></select></label><p>Chaque commande reste entière. Pour plusieurs SKU Erplain, classement sur le premier SKU dans l’ordre alphanumérique. Les fournisseurs et SKU Erplain non renseignés sont placés à la fin de leur groupe.</p><p><label style="display:inline-flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" data-include-excel style="display:inline-block;width:18px;height:18px;min-width:18px;margin:0;padding:0;flex:0 0 18px"> Générer aussi l’Excel des BL</label></p><button data-start>Préparer le PDF</button> <button data-close>Fermer</button><p data-stage role="status" aria-live="polite"></p><progress data-progress max="100" value="0" style="width:100%"></progress><p data-result></p><a data-file hidden>Télécharger le PDF</a><br><a data-excel hidden>Télécharger le détail Excel des BL</a><div data-items></div>';
 document.body.append(modal);modal.showModal();modal.querySelector('[data-count]').textContent=ids.length+' commande(s), '+deliveryIds.length+' livraison(s) et '+temuReferences.length+' référence(s) TEMU sélectionnées.';
 let closed=false;modal.querySelector('[data-close]').onclick=()=>modal.close();modal.addEventListener('close',()=>{closed=true;modal.remove();},{once:true});
 const outside=e=>{const r=modal.getBoundingClientRect();return e.target===modal&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
 let startedOutside=false;
 modal.addEventListener('pointerdown',e=>{startedOutside=outside(e);});
 modal.addEventListener('click',e=>{if(startedOutside&&outside(e))modal.close();startedOutside=false;});
 const start=modal.querySelector('[data-start]'),stage=modal.querySelector('[data-stage]'),bar=modal.querySelector('[data-progress]'),result=modal.querySelector('[data-result]');
 start.onclick=async()=>{start.disabled=true;modal.querySelector('[data-include-excel]').disabled=true;modal.querySelector('[data-excel]').hidden=true;modal.querySelector('[data-file]').hidden=true;result.textContent='';modal.querySelector('[data-sort]').disabled=true;const began=Date.now();
 try{const queued=await api('/api/labels/batches',{ids,temuReferences,deliveryIds,includeExcel:modal.querySelector('[data-include-excel]').checked,sort:modal.querySelector('[data-sort]').value});
  if(queued.existing)stage.textContent='Votre lot en cours est affiché ; aucun second téléchargement lancé.';
  while(!closed){const r=await api('/api/labels/batches/status?id='+encodeURIComponent(queued.id));const percent=typeof r.percent==='number'&&Number.isFinite(r.percent)?Math.max(0,Math.min(100,r.percent)):null;if(percent===null)bar.removeAttribute('value');else bar.value=percent;stage.textContent=(percent===null?'':percent+' % · ')+(r.stage||'En attente de préparation')+' · '+Math.floor((Date.now()-began)/1000)+' s';
   if(['complete','failed'].includes(r.status)){
    const missing=r.items.filter(x=>x.problems.length);result.textContent=r.status==='failed'?r.error:r.labels+' étiquette(s), '+r.pages+' page(s). '+(missing.length?missing.length+' commande(s)/livraison(s) avec un problème : voir le détail.':'Toutes les étiquettes disponibles ont été regroupées.');
    const box=modal.querySelector('[data-items]');box.innerHTML='<h3>Contenu du lot dans l’ordre du PDF</h3>';for(const x of r.items){const p=document.createElement('p');p.textContent=x.reference+' · '+x.labels+' étiquette(s)'+((!x.skus?.filter(Boolean).length&&x.id)?' · SKU Erplain non identifié':'')+(x.firstPage?' · pages '+x.firstPage+'–'+x.lastPage:'')+(x.problems.length?' · '+x.problems.join(' ; '):'');box.append(p);}
    if(r.status==='complete'){const link=modal.querySelector('[data-file]');link.href='/api/labels/batches/file?id='+encodeURIComponent(queued.id);link.download=r.filename;link.hidden=false;link.textContent='Télécharger : '+r.filename;link.click();if(r.includeExcel){const excel=modal.querySelector('[data-excel]');excel.href='/api/labels/batches/excel?id='+encodeURIComponent(queued.id);excel.download=r.excelFilename;excel.hidden=false;excel.textContent='Télécharger : '+r.excelFilename;if(r.excelRows===0){stage.textContent='PDF prêt · Excel sans ligne de BL : lecture à vérifier';excel.textContent='Télécharger le diagnostic Excel (aucun BL exporté)';}result.textContent+=' Excel : '+r.excelBlCount+' BL relu(s), '+r.excelWarnings+' point(s) signalé(s) dans Exceptions.';}}break;
   }await new Promise(resolve=>setTimeout(resolve,500));
  }
 }catch(e){result.textContent=e.message;}finally{if(!closed){start.disabled=false;start.textContent='Préparer un nouveau PDF';modal.querySelector('[data-include-excel]').disabled=false;modal.querySelector('[data-sort]').disabled=false;}}
 };
}

batchLabels.onclick=async()=>{batchLabels.disabled=true;try{await downloadMerged([...selected]);}catch(e){flash(e.message,true);}finally{selection();}};
const completeDialog=document.createElement('dialog');completeDialog.id='complete-label-dialog';document.body.append(completeDialog);
const detailBeforeCompletion=orderDetail;orderDetail=async function(id){const request=await detailBeforeCompletion(id);if(!orderDetailIsCurrent(request))return null;if(user.role!=='admin'&&!user.permissions?.includes('labels.complete'))return request;const b=document.createElement('button');b.textContent='Compléter les informations et créer l’étiquette';b.onclick=async()=>{try{const {order:o}=await api('/api/order-detail?id='+encodeURIComponent(id));if(!orderDetailIsCurrent(request))return;dialog.close();completeDialog.innerHTML=`<button id="complete-close">Fermer</button><h2>Compléter la commande ${esc(o.reference)}</h2><p>Complément transport uniquement. Les BC/BL existants ne seront pas modifiés. Les erreurs de mapping ou de stock Erplain restent à traiter séparément.</p><form id="complete-form"><div class="form-grid">${[['name','Destinataire'],['street','Adresse'],['postal','Code postal'],['city','Ville'],['country','Pays ISO'],['phone','Téléphone'],['email','Email']].map(([k,t])=>`<label>${t}<input name="${k}" value="${esc(o.address?.[k]||'')}" ${['name','street','postal','city','country'].includes(k)?'required':''}></label>`).join('')}<label>Poids total (kg)<input name="weight" type="number" step="0.001" min="0.001" max="3000" value="${esc(o.weight_kg||'')}" required></label><label>Transporteur<select name="carrier">${[['gls','GLS home'],['gls_pharma','GLS PHARMA'],['gofo','GOFO']].map(([k,t])=>`<option value="${k}" ${o.carrier===k?'selected':''}>${t}</option>`).join('')}</select></label></div><p>Une nouvelle demande utilise TEST par défaut. Une reprise conserve le circuit TEST/PROD de la demande précédente. Une création existante ou incertaine ne peut pas être forcée.</p><button class="primary">Enregistrer et générer</button><p id="complete-error" role="status"></p></form>`;completeDialog.showModal();$('complete-close').onclick=()=>completeDialog.close();$('complete-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;try{const values=Object.fromEntries(new FormData(form)),{weight,carrier,...address}=values;const result=await api('/api/labels/complete',{id,address,weight:Number(weight),carrier});completeDialog.close();flash(result.message);await orders();}catch(error){$('complete-error').textContent=error.message;}finally{button.disabled=false;}};}catch(error){flash(error.message,true);}};$('order-detail').prepend(b);return request;};
const oldUsers=users;users=async function(){await oldUsers();const r=await api('/api/users');const head=$('user-rows').parentElement.querySelector('thead tr');if(!head.querySelector('[data-permission-heading]'))head.insertAdjacentHTML('beforeend','<th data-permission-heading>Compléter une étiquette</th>');$('user-rows').innerHTML=r.rows.map(u=>`<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.role==='admin'?'Autorisé (administrateur)':`<input type="checkbox" data-label-permission="${esc(u.email)}" ${u.permissions?.includes('labels.complete')?'checked':''} aria-label="Autoriser ${esc(u.email)} à compléter une étiquette">`}</td></tr>`).join('');$('user-rows').querySelectorAll('[data-label-permission]').forEach(c=>c.onchange=async()=>{try{await api('/api/users/label-permission',{email:c.dataset.labelPermission,enabled:c.checked});}catch(e){c.checked=!c.checked;flash(e.message,true);}});};
// Move existing buttons without losing their handlers; each section can collapse.
const sidebar=document.querySelector('nav'),groups=[['orders','Commandes'],['shipping','Expéditions'],['settings','Paramètres']];let section='orders';const nodes=[...sidebar.children],containers=new Map();sidebar.replaceChildren();for(const [id,title]of groups){const details=document.createElement('details');details.className='nav-group';details.open=id==='orders'||id==='settings';details.innerHTML=`<summary>${title}</summary><div></div>`;containers.set(id,details);sidebar.append(details);}
for(const node of nodes){if(node.classList.contains('nav-label')){section=node.textContent.includes('EXPÉDITIONS')?'shipping':node.textContent.includes('PARAMÈTRES')?'settings':'orders';continue;}const target=node.dataset.view==='temu'?'shipping':section;containers.get(target).querySelector('div').append(node);}
const temuShortcut=sidebar.querySelector('[data-carrier="temu"]');if(temuShortcut){temuShortcut.onclick=()=>show('temu');const duplicate=sidebar.querySelector('[data-view="temu"]');if(duplicate)duplicate.remove();temuShortcut.dataset.view='temu';temuShortcut.textContent='Étiquettes TEMU';}
const showBeforeNavigation=show;show=async function(view){await showBeforeNavigation(view);sidebar.querySelectorAll('button').forEach(b=>{const active=b.dataset.view===view||view==='orders'&&b.dataset.channel&&[...$('channel').selectedOptions].some(o=>o.value===b.dataset.channel);b.classList.toggle('active',active);if(active)b.closest('details').open=true;});};
function erplainCapacityView(s){
 const fallback={text:'Capacité Erplain LIVE non vérifiée. Chaque création de BC est contrôlée.',warning:false};
 if(!s||s.error)return fallback;
 const count=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
 const current=count(s.current),limit=count(s.limit),remaining=count(s.remaining),missing=count(s.missing);
 const parts=[];
 if(current!==null)parts.push('Erplain LIVE : '+current+(limit!==null?' / '+limit:'')+' commandes');
 else parts.push('Nombre de commandes Erplain LIVE non vérifié');
 if(limit===null)parts.push('plafond non renseigné');
 else if(current===null)parts.push('plafond : '+limit+' commandes');
 if(remaining!==null)parts.push(remaining+' places restantes');
 if(missing!==null)parts.push('nouveaux BC V3 manquants : '+missing);
 return {text:parts.join(' · '),warning:current!==null&&missing!==null&&limit!==null&&current+missing>limit};
}
const capacity=document.createElement('p');capacity.id='live-capacity';document.querySelector('#view-orders .panel').prepend(capacity);const oldOrders=orders;orders=async function(){await oldOrders();let view;try{view=erplainCapacityView(orderRenderData.capacity);}catch{view=erplainCapacityView(null);}capacity.textContent=view.text;capacity.classList.toggle('capacity-warning',view.warning);};
// One operational tab: the command and all of its deliveries stay together.
for(const button of [...sidebar.querySelectorAll('[data-channel],[data-carrier],[data-view="temu"]')])button.remove();
containers.get('shipping')?.remove();
const commandNav=sidebar.querySelector('[data-view="orders"]');commandNav.textContent='Commandes et livraisons';
const commandSummary=containers.get('orders')?.querySelector('summary');if(commandSummary)commandSummary.textContent='Traitement';
const dedicatedTemu=document.createElement('button');dedicatedTemu.dataset.view='temu';dedicatedTemu.textContent='Étiquettes TEMU';dedicatedTemu.onclick=()=>show('temu');containers.get('orders').querySelector('div').append(dedicatedTemu);
const showUnifiedBase=show;show=async function(view){if(view==='shipments')view='orders';await showUnifiedBase(view);if(view==='orders')$('title').textContent='Commandes et livraisons';};
const selectedDeliveries=new Set();
const selectionUnifiedBase=selection;selection=()=>{selectionUnifiedBase();const total=selected.size+selectedDeliveries.size;$('selection-count').textContent=total+' sélection'+(total>1?'s':'');batchLabels.disabled=!total;};
batchLabels.onclick=async()=>{batchLabels.disabled=true;try{await downloadMerged([...selected],[],[...selectedDeliveries]);}catch(e){flash(e.message,true);}finally{selection();}};
const unifiedOrdersBase=orders;orders=async function(){const expectedVersion=orderRequestVersion+1;await unifiedOrdersBase();if(orderRenderData?.version!==expectedVersion||orderRequestVersion!==expectedVersion)return;const roots=[...$('order-rows').querySelectorAll('[data-detail]')].filter(link=>!preservedOrderRows.has(link.dataset.detail));
for(const link of roots){const cells=link.closest('tr').cells,raw=cells[2].textContent.trim();cells[2].title=raw;const view=orderPlacedDateView(cells[2].dataset.orderDate||'');cells[2].innerHTML=view.html;cells[2].title=view.title;for(const cell of cells)cell.title||=cell.textContent.trim();}
if(!roots.length){lastPartialSnapshot=JSON.stringify(orderRenderData.partial.rows);return;}try{const result=orderRenderData.partial;lastPartialSnapshot=JSON.stringify(result.rows);const groups=new Map();for(const d of result.rows){if(!groups.has(d.order_id))groups.set(d.order_id,[]);groups.get(d.order_id).push(d);}
for(const link of roots){const deliveries=groups.get(link.dataset.detail)||[];if(!deliveries.length)continue;const parent=link.closest('tr');parent.classList.add('has-deliveries');parent.cells[1].insertAdjacentHTML('beforeend','<small>Commande globale · '+deliveries.length+' livraison(s)</small>');let after=parent;
for(const [index,d]of deliveries.entries()){if(d.status==='cancelled')selectedDeliveries.delete(d.id);const row=document.createElement('tr');row.className='delivery-row'+(d.status==='cancelled'?' order-cancelled':'');row.innerHTML=`<td><input type="checkbox" data-delivery-select="${esc(d.id)}" ${selectedDeliveries.has(d.id)&&d.status!=='cancelled'?'checked':''} ${d.status==='cancelled'?'disabled':''} aria-label="Sélectionner livraison ${index+1} de ${esc(d.reference)}"></td><td><button class="link-button" data-delivery-detail="${esc(d.order_id)}">${esc(d.reference)}</button><small>Livraison ${index+1}</small></td><td>${new Date(d.created_at).toLocaleDateString('fr-FR')}</td><td>${esc(d.erp_live?.bc?.label||'—')}<small class="erp-status" data-status="${esc(d.erp_live?.bc?.status||'unknown')}">${esc(erpStatusText(d.erp_live?.bc?.status))}</small><button class="link-button" data-erplain-document-refresh="${esc(d.order_id)}" data-erplain-document-kind="bc">Actualiser le BC Erplain</button></td><td>${esc(d.bl?.label||'En attente')}<small class="erp-status" data-status="${esc(d.bl?.status||'unknown')}">${esc(erpStatusText(d.bl?.status))}</small><button class="link-button" data-erplain-document-refresh="${esc(d.order_id)}" data-erplain-document-kind="bl">Actualiser le BL Erplain</button></td><td>${esc(d.recipient)}<small>${esc(d.address?.country)} · ${esc(d.address?.city)}</small></td><td class="total-quantity-column">${d.selection.reduce((n,l)=>n+Number(l.quantity),0)}<small>Unités Erplain</small></td><td>${d.selection.map(l=>esc(l.sku)+' ('+esc(l.quantity)+')').join('<br>')}</td><td>${esc(({gls:'GLS home',gls_pharma:'GLS PHARMA',gofo:'GOFO'})[d.carrier]||'À déterminer')}<small>${esc(partialWeightText(d.weight_kg))} kg · ${esc(d.parcel_count||'—')} colis</small></td><td>${esc(partialStatuses[d.status]||d.status)}${d.error?'<small>'+esc(d.error)+'</small>':''}${Array.from({length:d.documents},(_,i)=>`<a class="pdf-link" href="/api/partial/documents/${encodeURIComponent(d.id)}/${i}" target="_blank" rel="noopener">${d.status==='cancelled'?'Ancienne étiquette — BL annulé · ':''}▤ PDF ${d.environment==='production'?'PROD':d.environment==='test'?'TEST':'ENV. NON IDENTIFIÉ'} ${i+1}/${d.documents} ↗</a>`).join('<br>')}</td><td>${(d.tracking||[]).map(esc).join('<br>')||'En attente'}</td>`;after.after(row);after=row;for(const cell of row.cells)cell.title=cell.textContent.trim();}
}
$('order-rows').querySelectorAll('[data-delivery-select]').forEach(el=>el.onchange=()=>{el.checked?selectedDeliveries.add(el.dataset.deliverySelect):selectedDeliveries.delete(el.dataset.deliverySelect);selection();});$('order-rows').querySelectorAll('[data-delivery-detail]').forEach(el=>el.onclick=()=>orderDetail(el.dataset.deliveryDetail));selection();
}catch(e){flash('Chargement des livraisons partielles : '+e.message,true);}};
const clearUnifiedSelection=selected.clear.bind(selected);selected.clear=()=>{clearUnifiedSelection();selectedDeliveries.clear();};
const quantityHeading=document.querySelector('#view-orders thead th:nth-child(7) .sort-button');if(quantityHeading){quantityHeading.textContent='Qté ↕';quantityHeading.title='Quantité de produits';}
// Keep synchronization diagnostics in Connections, away from daily order processing.
$('view-connections').prepend($('erplain-progress'));



// Export the complete filtered population, independently of table pagination.
async function collectFilteredLabelOrders(query,readPage,onProgress=()=>{}){
 const params=new URLSearchParams(query);params.set('pageSize','200');
 const ids=new Set();let total=null,expectedPages=null;
 for(let current=1;;current++){
  params.set('page',String(current));const result=await readPage('/api/orders?'+params);
  if(!Array.isArray(result.rows)||!Number.isSafeInteger(result.total)||result.total<0||!Number.isSafeInteger(result.pages)||result.pages<1)throw Error('Liste filtrée incomplète. Relancez le téléchargement.');
  if(total===null){total=result.total;expectedPages=result.pages;}
  if(result.total!==total||result.pages!==expectedPages)throw Error('La liste filtrée a changé pendant sa lecture. Relancez le téléchargement.');
  for(const row of result.rows){if(typeof row.id!=='string'||!row.id||ids.has(row.id))throw Error('La liste filtrée a changé pendant sa lecture. Relancez le téléchargement.');ids.add(row.id);}
  onProgress(ids.size,total);
  if(current>=expectedPages)break;
  if(!result.rows.length)throw Error('Liste filtrée incomplète. Relancez le téléchargement.');
 }
 if(ids.size!==total)throw Error('Liste filtrée incomplète. Relancez le téléchargement.');
 return [...ids];
}
const filteredBatchLabels=document.createElement('button');filteredBatchLabels.id='download-filtered-labels';filteredBatchLabels.textContent='Télécharger toutes les étiquettes filtrées';document.querySelector('#view-orders .batch').append(filteredBatchLabels);
filteredBatchLabels.onclick=async()=>{
 const query=orderFilterParams(1).toString();filteredBatchLabels.disabled=true;
 try{
  const ids=await collectFilteredLabelOrders(query,api,(count,total)=>{filteredBatchLabels.textContent='Lecture des commandes filtrées : '+count+'/'+total;});
  if(!ids.length){flash('Aucune commande pour ces filtres.');return;}
  await downloadMerged(ids);
 }catch(e){flash(e.message,true);}finally{filteredBatchLabels.disabled=false;filteredBatchLabels.textContent='Télécharger toutes les étiquettes filtrées';}
};
