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
 const modal=document.createElement('dialog');modal.id='order-information-dialog';modal.className='order-information-dialog';modal.setAttribute('aria-labelledby','order-information-title');
 modal.innerHTML='<header><h2 id="order-information-title"></h2><button type="button" data-close-information>Fermer</button></header><p data-information-feedback role="status"></p><div class="order-information-fields"></div>';document.body.append(modal);
 modal.querySelector('[data-close-information]').onclick=()=>modal.close();
 function openInformation(row){
  const reference=row.querySelector('[data-detail],[data-delivery-detail]');if(!reference)return;
  modal.querySelector('h2').textContent='Informations · '+reference.textContent.trim();modal.querySelector('[data-information-feedback]').textContent='';
  const fields=modal.querySelector('.order-information-fields');fields.replaceChildren();
  const headings=[...table.tHead.rows[0].cells];
  for(const [index,cell]of [...row.cells].entries()){
   if(index===0)continue;
   const section=document.createElement('section'),title=document.createElement('h3'),content=document.createElement('div');
   title.textContent=headings[index]?.textContent.replace(/[↕↗]/g,'').trim()||'Informations';
   const copy=cell.cloneNode(true),originalControls=[...cell.querySelectorAll('button,a,input,select,textarea,[role="button"]')],copies=[...copy.querySelectorAll('button,a,input,select,textarea,[role="button"]')],stocks=[...cell.querySelectorAll('[data-stock-information]')],stockCopies=[...copy.querySelectorAll('[data-stock-information]')];
   for(const element of [copy,...copy.querySelectorAll('*')])for(const attr of [...element.attributes])if(attr.name==='id'||attr.name.startsWith('data-')||['aria-controls','aria-labelledby','aria-describedby'].includes(attr.name))element.removeAttribute(attr.name);
   for(const [i,info]of stockCopies.entries())window.V3StockInformation?.populate(info,stocks[i].dataset.stockInformation);
   for(const [i,control]of copies.entries()){
    const original=originalControls[i];
    if(original.matches('[data-order-more-info],.processing-details-toggle')){control.remove();continue;}
    control.addEventListener('click',event=>{
     event.preventDefault();event.stopImmediatePropagation();
     if(!original.isConnected||original.disabled){control.disabled=true;modal.querySelector('[data-information-feedback]').textContent='Cette action a changé. Fermez puis rouvrez les informations pour consulter son état actuel.';return;}
     modal.close();original.click();
    },true);
   }
   while(copy.firstChild)content.append(copy.firstChild);section.append(title,content);fields.append(section);
  }
  if(!modal.open)modal.showModal();
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
   if(!row.querySelector('[data-order-more-info]')){
    const button=document.createElement('button');button.type='button';button.dataset.orderMoreInfo='';button.className='order-more-information';button.textContent='Plus d’informations';button.setAttribute('aria-haspopup','dialog');button.onclick=()=>openInformation(row);reference.closest('td').append(button);
   }
  }
 }
 // Only structural table changes need layout; ticking durations do not.
 new MutationObserver(records=>{if(records.some(r=>r.target===body||r.target.nodeName==='TR'))layout();}).observe(table,{childList:true,subtree:true});
 layout();
})();
