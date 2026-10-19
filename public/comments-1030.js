// Review of Commentaires Aziz 04 October 10h30.
(()=>{
 const toggle=document.createElement('button');toggle.id='toggle-navigation';toggle.type='button';toggle.setAttribute('aria-controls','workspace-navigation');document.querySelector('aside').id='workspace-navigation';const bar=document.createElement('div');bar.className='workspace-titlebar';bar.append(toggle);$('app').prepend(bar);toggle.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>';
 const setMenu=hidden=>{document.body.classList.toggle('navigation-hidden',hidden);toggle.title=hidden?'Afficher le menu':'Masquer le menu';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded',String(!hidden));};setMenu(localStorage.getItem('v3-menu-hidden')==='true');toggle.onclick=()=>{const hide=!document.body.classList.contains('navigation-hidden');setMenu(hide);localStorage.setItem('v3-menu-hidden',String(hide));};
 const filters=document.querySelector('#view-orders .filters');filters.classList.add('ordered-filters');const actions=document.createElement('div');actions.className='order-filter-actions';filters.after(actions);
 for(const b of [$('clear-filters'),$('reload'),$('all-problems'),typeof erpRefreshButton!=='undefined'?erpRefreshButton:null])if(b)actions.append(b);
 const problemsButton=$('all-problems');
 const syncProblemsButton=()=>{const active=[...$('status').selectedOptions].some(o=>o.value==='__problems');problemsButton.classList.toggle('problems-filter-active',active);problemsButton.setAttribute('aria-pressed',String(active));problemsButton.textContent=active?'✓ Tous les problèmes · actif':'Afficher tous les problèmes';};
 const ordersBeforeProblemState=orders;orders=async function(...args){syncProblemsButton();return ordersBeforeProblemState.apply(this,args);};
 problemsButton.onclick=()=>{const option=[...$('status').options].find(o=>o.value==='__problems');if(option?.selected){option.selected=false;page=1;selected.clear();if(typeof selectedDeliveries!=='undefined')selectedDeliveries.clear();selection();}else{resetFilters();if($('problem-type'))$('problem-type').selectedIndex=-1;$('status').value='__problems';}syncProblemsButton();compactFilters.forEach(x=>x.sync());show('orders');};
 $('status').addEventListener('change',syncProblemsButton);
 for(const button of [problemsButton,$('clear-filters')])button.addEventListener('click',()=>queueMicrotask(syncProblemsButton));
 syncProblemsButton();
 const search=$('search');search.classList.add('order-search');search.placeholder='Rechercher une commande, un BC, un BL, un SKU ou un destinataire';filters.prepend(search);
 for(const id of ['channel','status','carrier','country','tracking-filter']){const select=$(id),box=select.nextElementSibling;if(box?.classList.contains('compact-filter')){const parent=select.parentElement;filters.append(box);if(parent.tagName==='LABEL')parent.hidden=true;}}
 for(const id of ['from','to'])filters.append($(id).closest('label')||$(id));const problem=$('problem-type');if(problem?.nextElementSibling?.classList.contains('compact-filter'))filters.append(problem.nextElementSibling);
 const size=document.createElement('label');size.textContent='Commandes par page ';const select=document.createElement('select');select.id='orders-page-size';for(const n of [50,100,200])select.add(new Option(String(n),String(n)));size.append(select);document.querySelector('#view-orders .pagination').prepend(size);select.onchange=()=>{page=1;selected.clear();if(typeof selectedDeliveries!=='undefined')selectedDeliveries.clear();selection();orders().catch(e=>flash(e,true));};
 const rows=$('order-rows');rows.addEventListener('click',e=>{if(e.target.closest('[data-detail]')&&window.getSelection()?.toString().trim()){e.stopImmediatePropagation();}},true);
 rows.addEventListener('keydown',e=>{const ref=e.target.closest('.selectable-reference');if(ref&&(e.key==='Enter'||e.key===' ')){e.preventDefault();orderDetail(ref.dataset.detail);}});
 const names={amazon:'Amazon',shopify:'Shopify',temu:'TEMU',rakuten:'Rakuten'};for(const opt of $('mapping-edit').elements.channel.options)opt.textContent=names[opt.value]||opt.textContent;
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Actualiser les correspondances';refresh.onclick=async()=>{refresh.disabled=true;try{await mappings();$('mapping-feedback').textContent='Correspondances actualisées. L’export des SKU à mapper recalcule les références manquantes à chaque téléchargement.';}catch(e){$('mapping-feedback').textContent=displayErrorMessage(e);}finally{refresh.disabled=false;}};$('mapping-search').before(refresh);
 for(const link of document.querySelectorAll('#view-mappings a[href*="/api/mappings/"]')){link.classList.add('mapping-download');link.addEventListener('click',()=>{const u=new URL(link.href);u.searchParams.set('at',Date.now());link.href=u.pathname+u.search;});}
 function renameText(root){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode()){const n=walker.currentNode;if(!n.parentElement.closest('script,style,pre,textarea,option')&&/\b[Cc]anal\b/.test(n.nodeValue))nodes.push(n);}for(const n of nodes)n.nodeValue=n.nodeValue.replace(/\bCanal\b/g,'Gestionnaire').replace(/\bcanal\b/g,'gestionnaire');}
 renameText(document.body);const observer=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)renameText(n);});observer.observe(document.body,{childList:true,subtree:true});
})();

// One layout for the four primary status controls, with reference space shared by the row.
(()=>{
 const statusGeometry=new WeakMap();
 function alignOrderStatuses(){
 const columns=[...document.querySelectorAll('#view-orders thead tr:first-child th')];
 const indices=['bc','bl','label','tracking'].map(name=>columns.findIndex(th=>th.dataset.column===name));if(indices.some(i=>i<0))return;
 // Collect signatures before changing any row, so layout reads remain grouped.
 const pending=[];
 for(const row of $('order-rows').rows){if(!row.querySelector('[data-detail]'))continue;const cells=indices.map(i=>row.cells[i]);if(cells.some(c=>!c))continue;const signature=cells.map(c=>c.clientWidth+':'+c.textContent).join('|');if(statusGeometry.get(row)===signature)continue;pending.push({row,cells,signature});}
 for(const item of pending){const {row,cells}=item;cells.forEach((cell,i)=>{cell.classList.add('aligned-status-cell');cell.classList.toggle('status-with-reference',i<2);cell.classList.toggle('status-with-spacer',i>=2);});item.controls=cells.map((cell,i)=>i<2?cell.querySelector('.erp-status'):cell.querySelector(':scope > .badge,:scope > .pdf-link'));for(const c of item.controls)if(c)c.classList.add('aligned-primary-status');row.style.removeProperty('--status-reference-height');row.style.removeProperty('--status-control-height');}
 // Every reference is measured with the same cleared control-height state.
 for(const item of pending)item.refHeight=Math.max(20,...item.cells.slice(0,2).map(c=>c.querySelector('.erp-reference')?.getBoundingClientRect().height||0));
 for(const item of pending)item.row.style.setProperty('--status-reference-height',item.refHeight+'px');
 for(const item of pending)item.height=Math.max(44,...item.controls.filter(Boolean).map(c=>c.getBoundingClientRect().height));
 for(const item of pending){item.row.style.setProperty('--status-control-height',item.height+'px');statusGeometry.set(item.row,item.signature);}
 }
 const previous=orders;orders=async function(...args){const result=await previous.apply(this,args);alignOrderStatuses();return result;};
 let lastWidth=-1,frame=0;new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width===lastWidth)return;lastWidth=width;cancelAnimationFrame(frame);frame=requestAnimationFrame(alignOrderStatuses);}).observe(document.querySelector('#view-orders .table-wrap'));
 alignOrderStatuses();
})();
