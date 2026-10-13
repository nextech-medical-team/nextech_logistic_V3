let orderRefreshFailureNotice=null,orderFlashRevision=0,orderRenderAttemptRevision=0,orderAcceptedRenderRevision=0;
const orderRefreshRenderErrors=new WeakMap();
function clearOrderRefreshFailureNotice(){const notice=orderRefreshFailureNotice;if(!notice)return;const node=$('flash');if(node===notice.node&&node.textContent===notice.text&&node.className===notice.className){node.hidden=true;}orderRefreshFailureNotice=null;}
// Compare the data belonging to each displayed row, including its diagnostics.
function orderRowVersions(snapshot,partial,diagnostics){
 const result=new Map(),groups=new Map();
 for(const d of partial||[]){if(!groups.has(d.order_id))groups.set(d.order_id,[]);groups.get(d.order_id).push(d);result.set('delivery:'+d.id,JSON.stringify(d));}
 const issues=new Map((diagnostics?.rows||[]).map(o=>[o.id,o]));
 for(const o of snapshot?.rows||[])result.set('order:'+o.id,JSON.stringify([{...o,updated_at:undefined},groups.get(o.id)||[],issues.get(o.id)||null]));
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
