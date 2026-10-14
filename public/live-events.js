let orderRefreshFailureNotice=null,orderFlashRevision=0,orderRenderAttemptRevision=0,orderAcceptedRenderRevision=0;
const orderRefreshRenderErrors=new WeakMap();
function clearOrderRefreshFailureNotice(){const notice=orderRefreshFailureNotice;if(!notice)return;const node=$('flash');if(node===notice.node&&node.textContent===notice.text&&node.className===notice.className){node.hidden=true;}orderRefreshFailureNotice=null;}
// Compare the data belonging to each displayed row, including its diagnostics.
function orderRowVersions(snapshot,partial,diagnostics){
 const result=new Map(),groups=new Map();
 for(const d of partial||[]){if(!groups.has(d.order_id))groups.set(d.order_id,[]);groups.get(d.order_id).push(d);result.set('delivery:'+d.id,JSON.stringify(d));}
 const issues=new Map((diagnostics?.rows||[]).map(o=>[o.id,o]));
 for(const o of snapshot?.rows||[]){
 result.set('order:'+o.id,JSON.stringify([{...o,updated_at:undefined},groups.get(o.id)||[],issues.get(o.id)||null]));
 // Diagnostics are not rendered in the orders table; displayed statuses come from o.
 result.set('supplement:'+o.id,JSON.stringify(groups.get(o.id)||[]));
 }
 return result;
}
(()=>{
 const previousFlash=flash;flash=function(...args){orderFlashRevision++;orderRefreshFailureNotice=null;return previousFlash.apply(this,args);};
 const render=orders;
 const rowKey=row=>{const order=row.querySelector('[data-detail]')?.dataset.detail;if(order)return 'order:'+order;const delivery=row.querySelector('[data-delivery-select]')?.dataset.deliverySelect;return delivery?'delivery:'+delivery:null;};
 orders=async function(...args){
  const renderAttempt=++orderRenderAttemptRevision;
  const expectedVersion=orderRequestVersion+1,body=$('order-rows');
  const previous=lastOrdersSnapshot?JSON.parse(lastOrdersSnapshot):null;
  const oldVersions=orderRowVersions(previous,lastPartialSnapshot?JSON.parse(lastPartialSnapshot):[],orderRenderData?.diagnostics);
  const oldRows=new Map([...body.rows].map(row=>[rowKey(row),row]));
  const quietResponse=preparedOrderResponse;
  try{await render.apply(this,args);}
  catch(error){if(quietResponse&&error&&typeof error==='object'&&orderRequestVersion===expectedVersion)orderRefreshRenderErrors.set(error,{version:expectedVersion,query:quietResponse.query});throw error;}
  if(orderRequestVersion!==expectedVersion||orderRenderData?.version!==expectedVersion||currentView!=='orders')return;
  orderAcceptedRenderRevision=renderAttempt;
  clearOrderRefreshFailureNotice();
  const nextVersions=orderRowVersions(JSON.parse(lastOrdersSnapshot),orderRenderData.partial.rows,orderRenderData.diagnostics);
  const referenceSelection=selectedOrderReference();
  // All enrichments completed in the same microtask turn. Reuse unchanged DOM
  // before the next browser paint, preserving progress, focus and selection.
  for(const row of [...body.rows]){const key=rowKey(row),old=oldRows.get(key);if(key&&old&&old!==row&&old.cells.length===row.cells.length&&oldVersions.get(key)===nextVersions.get(key))row.replaceWith(old);}
  const headings=[...body.closest('table').tHead.rows[0].cells].map(cell=>cell.textContent.replace(/[↕↗]/g,'').trim());
  for(const row of body.rows)for(const [index,cell] of [...row.cells].entries()){if(headings[index]&&cell.dataset.orderColumn!==headings[index])cell.dataset.orderColumn=headings[index];}
  window.V3OrderProcessing?.acceptSnapshot(orderRenderData.processing);
  restoreSelectedOrderReference(referenceSelection);
 };
})();
(()=>{
 let stream,timer,active=false,pending=false,refreshing=false;
 function schedule(delay=250){if(!timer)timer=setTimeout(flush,delay);}
 const refresh=()=>{pending=true;schedule();};
 async function flush(){timer=null;if(refreshing)return;if(typeof user==='undefined'||!user||document.hidden)return;refreshing=true;pending=false;
  const attemptedView=currentView,attemptedVersion=orderRequestVersion,attemptedQuery=lastOrdersQuery,attemptedUser=user,attemptedFlashRevision=orderFlashRevision,attemptedRenderRevision=orderRenderAttemptRevision;
  const attemptedFlash=$('flash'),attemptedText=attemptedFlash.textContent,attemptedClass=attemptedFlash.className;
  try{if(currentView==='orders'){const refreshed=await refreshOrdersQuietly();if(refreshed===true&&currentView===attemptedView&&lastOrdersQuery===attemptedQuery&&user===attemptedUser&&(orderRenderAttemptRevision===attemptedRenderRevision||orderAcceptedRenderRevision===orderRenderAttemptRevision))clearOrderRefreshFailureNotice();else pending=true;}else if(currentView==='products')await products();else if(currentView==='shipments')await shipments();else if(currentView==='stocks'&&typeof stocksView==='function')await stocksView();}
  catch(e){pending=true;const renderFailure=e&&typeof e==='object'?orderRefreshRenderErrors.get(e):null;if(attemptedView==='orders'&&currentView==='orders'&&(attemptedVersion===orderRequestVersion||(renderFailure?.version===orderRequestVersion&&renderFailure?.query===attemptedQuery))&&attemptedQuery===lastOrdersQuery&&attemptedUser===user&&attemptedFlashRevision===orderFlashRevision&&$('flash')===attemptedFlash&&attemptedFlash.textContent===attemptedText&&attemptedFlash.className===attemptedClass){flash('Actualisation momentanément indisponible : '+e.message,true);const node=$('flash');orderRefreshFailureNotice={node,text:node.textContent,className:node.className};}}
  finally{refreshing=false;if(pending)schedule(1000);}
 }
 function connect(){if(typeof user==='undefined'||!user){stream?.close();stream=null;active=false;return;}if(stream)return;stream=new EventSource('/api/events');stream.addEventListener('change',refresh);stream.onopen=()=>{active=true;};stream.onerror=()=>{active=false;};}
 setInterval(connect,2000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){connect();refresh();}});window.addEventListener('beforeunload',()=>stream?.close());window.NextechEvents={get active(){return active;}};
})();


(()=>{
 const body=document.getElementById('order-rows'),table=body?.closest('table');if(!table)return;
 const weights={reference:1.35,manager:.9,date:.8,bc:.9,bl:.9,recipient:1.2,sku:1.35,carrier:1.1,label:1.5,tracking:1,'erplain-tracking':1,'platform-status':1,'country-margin':1};
 const expanded=new Set();
 const tooltip=document.createElement('div');tooltip.id='order-action-tooltip';tooltip.role='tooltip';tooltip.hidden=true;document.body.append(tooltip);
 let describedControl=null;
 function hideTooltip(){tooltip.hidden=true;describedControl?.removeAttribute('aria-describedby');describedControl=null;}
 function showTooltip(event){const control=event.target.closest?.('.order-icon-action');if(!control)return;describedControl?.removeAttribute('aria-describedby');describedControl=control;tooltip.textContent=control.title;tooltip.hidden=false;control.setAttribute('aria-describedby',tooltip.id);const box=control.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(box.left,innerWidth-tooltip.offsetWidth-8))+'px';tooltip.style.top=Math.max(8,box.top-tooltip.offsetHeight-8)+'px';}
 body.addEventListener('mouseover',showTooltip);body.addEventListener('focusin',showTooltip);
 body.addEventListener('mouseout',event=>{if(describedControl&&!describedControl.contains(event.relatedTarget))hideTooltip();});body.addEventListener('focusout',hideTooltip);body.addEventListener('click',hideTooltip);window.addEventListener('scroll',hideTooltip,true);window.addEventListener('resize',hideTooltip);

 function apply(row,reference,button,key){
  const open=expanded.has(key),changed=row.classList.contains('order-row-expanded')!==open;
  row.classList.toggle('order-row-expanded',open);
  button.textContent=open?'▴':'▾';button.setAttribute('aria-expanded',String(open));
  const label=(open?'Replier':'Déplier')+' les informations de '+reference.textContent.trim();
  button.setAttribute('aria-label',label);button.title=label;
  if(open&&changed)for(const info of row.querySelectorAll('[data-stock-information]'))window.V3StockInformation?.populate(info,info.dataset.stockInformation);
 }
 function layout(){
  const headings=[...table.tHead.rows[0].cells],visible=headings.filter(h=>!h.classList.contains('total-quantity-column'));
  const columns=visible.map(h=>h.dataset.column==='select'?'28px':'minmax(0,'+(weights[h.dataset.column]||1)+'fr)').join(' ');
  if(table.style.getPropertyValue('--order-fixed-columns')!==columns)table.style.setProperty('--order-fixed-columns',columns);
  table.classList.add('orders-fixed-layout');
  for(const row of body.rows){
   const reference=row.querySelector('[data-detail],[data-delivery-detail]');
   if(!reference){for(const cell of row.cells)cell.style.gridColumn='1 / -1';continue;}
   let column=0;
   for(const [index,cell]of [...row.cells].entries()){
    const heading=headings[index];if(!heading)continue;
    cell.dataset.fixedColumn=heading.dataset.column||String(index);cell.dataset.orderColumn=heading.textContent.replace(/[↕↗]/g,'').trim();
    if(heading.classList.contains('total-quantity-column'))continue;
    const position=String(++column);if(cell.style.gridColumn!==position)cell.style.gridColumn=position;
   }
   for(const control of row.querySelectorAll('button.link-button,a.link-button[data-problem-deferral-id]')){
    if(control.classList.contains('order-icon-action'))continue;
    const text=control.textContent.trim();let icon='';
    const documentKind=control.dataset.erplainDocumentKind;
    if(documentKind)icon='<path d="M15 3H6v18h13V7l-4-4Zm0 0v5h4"/><path d="M9 12a4 4 0 0 1 6-1m1-2v3h-3M15 17a4 4 0 0 1-6 0"/><text x="12" y="21" text-anchor="middle" stroke="none" fill="currentColor" font-size="5">'+(documentKind==='bc'?'BC':'BL')+'</text>';
    else if(/transporteur/i.test(text))icon='<path d="M2 7h12v10H2zM14 10h4l4 4v3h-8M5 7V4h8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>';
    else if(/étiquette|étiquettes/i.test(text))icon='<path d="M3 3h9l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1"/>'+(/externe/i.test(text)?'<path d="M12 15V9m-3 3 3-3 3 3"/>':'<path d="m10 14 2 2 5-5"/>');
    else if(/Remplacer un produit/i.test(text))icon='<path d="m4 7 8-4 8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10M2 12h5m-2-2 2 2-2 2M22 12h-5m2-2-2 2 2 2"/>';
    else if(/suspend|Réactiver/i.test(text))icon='<circle cx="12" cy="12" r="9"/><path d="M9 8v8m6-8v8"/>';
    else if(/Différer|report|Remettre en actif/i.test(text))icon='<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>';
    else if(/Vérifier le BC/i.test(text))icon='<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 14l3 3 5-6"/>';
    if(!icon){if(!control.title)control.title=text;continue;}
    control.title=text+(control.title&&control.title!==text?' — '+control.title:'');control.setAttribute('aria-label',text);control.classList.add('order-icon-action');delete control.dataset.compactLabel;
    control.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icon+'</svg><span class="order-action-name">'+esc(text)+'</span>';
   }
   const key=reference.hasAttribute('data-delivery-detail')?'delivery:'+row.querySelector('[data-delivery-select]').dataset.deliverySelect:'order:'+reference.dataset.detail;
   let button=row.querySelector('[data-order-more-info]');
   if(!button){
    button=document.createElement('button');button.type='button';button.dataset.orderMoreInfo='';button.className='order-more-information';
    button.onclick=event=>{event.stopPropagation();if(expanded.has(key))expanded.delete(key);else expanded.add(key);apply(row,reference,button,key);};
    reference.after(button);
   }
   apply(row,reference,button,key);
  }
 }
 // Content updates cannot resize a collapsed row. Restore deliberate expansion after row replacement.
 new MutationObserver(records=>{if(records.some(r=>r.target===body||r.target.nodeName==='TR'||[...r.addedNodes].some(n=>n.nodeType===1&&n.matches?.('button.link-button,a.link-button[data-problem-deferral-id]'))))layout();}).observe(table,{childList:true,subtree:true});
 layout();
})();
