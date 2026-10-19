// Installed tender behavior retained; independent UI state avoids cross-channel cache effects.
(()=>{
 const root=document.getElementById('order-rows');if(!root)return;
 const cache=new Map(),pending=new Map(),queue=[];let running=0;
 const format=value=>value===null||value===undefined?'non vérifiée':Number(value).toLocaleString('fr-FR');
 function html(data){
  return '<span>À venir ERPLAIN : '+esc(format(data.original.incoming))+'</span><br>'+
   (data.equivalentCount?'<span>Équivalent'+(data.equivalentCount>1?'s':'')+' enregistré'+(data.equivalentCount>1?'s':'')+' dans V3 : '+data.equivalents.map(e=>esc(e.sku)+' · '+(e.available===null?'stock non vérifié':esc(format(e.available))+' disponible'+(e.available>1?'s':''))).join(' ; ')+(data.equivalentCount>data.equivalents.length?' ; autres équivalents à consulter':'')+'</span>':'<span>Aucun équivalent enregistré dans V3</span>')+
   '<br><span>Emplacement V3 '+esc(data.locationId)+' · lu le '+esc(new Date(data.checkedAt).toLocaleString('fr-FR'))+'</span>';
 }
 function pump(){while(running<2&&queue.length){const {sku,resolve}=queue.shift();running++;let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Lecture trop longue')),20000);});
  Promise.race([api('/api/equivalences/stock-information?'+new URLSearchParams({sku}),undefined,{timeoutMs:20000}),deadline]).then(data=>{
   if(!data?.original||!Array.isArray(data.equivalents)||!Number.isFinite(Date.parse(data.expiresAt)))throw Error('Réponse stock incomplète');
   cache.set(sku,{until:Date.parse(data.expiresAt),data});resolve(data);
  }).catch(()=>{const data={error:true};cache.set(sku,{until:Date.now()+60000,data});resolve(data);}).finally(()=>{clearTimeout(timer);running--;pending.delete(sku);pump();});}}
 function load(sku){const prior=cache.get(sku);if(prior?.until>Date.now())return Promise.resolve(prior.data);if(pending.has(sku))return pending.get(sku);const promise=new Promise(resolve=>queue.push({sku,resolve}));pending.set(sku,promise);pump();return promise;}
 function show(info,data){if(!info.isConnected)return;info.dataset.expiresAt=String(cache.get(info.dataset.stockInformation)?.until||Date.now()+60000);if(info.hasAttribute('data-stock-preview')){info.textContent=info.dataset.stockInformation+' · À venir : '+(data.error?'lecture indisponible':format(data.original.incoming));return;}if(data.error){info.innerHTML='À venir ERPLAIN : lecture indisponible ou différée · équivalents V3 : non vérifiés<br><button type="button" class="link-button" data-stock-retry>Réessayer la lecture</button>';info.querySelector('[data-stock-retry]').onclick=()=>{cache.delete(info.dataset.stockInformation);info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));};}else info.innerHTML=html(data);}
 window.V3StockInformationTender={populate(info,sku){info.dataset.stockInformation=sku;info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(sku).then(data=>show(info,data));}};
 // Read only rows currently visible; hidden rows must not monopolize the two slots.
 const watched=new Set();
 const visible=new IntersectionObserver(entries=>{for(const {target:info,isIntersecting}of entries)if(isIntersecting&&info.isConnected&&!info.dataset.started){info.dataset.started='true';info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));visible.unobserve(info);watched.delete(info);}},{rootMargin:'0px'});
 function refresh(){
  for(const summary of root.querySelectorAll('[data-stock-preview]'))if(summary.parentElement?.dataset.fixedColumn!=='sku')summary.remove();
  for(const info of watched)if(!info.isConnected){visible.unobserve(info);watched.delete(info);}
  for(const button of root.querySelectorAll('.compact-problem[data-problem-type="stock"]')){
   if((button.dataset.stockChannel==='tender')!==true)continue;
   const sku=button.dataset.problemSku;if(!sku)continue;
   const row=button.closest('tr'),cell=row?.querySelector('td[data-fixed-column="sku"]');
   if(cell&&![...cell.querySelectorAll('[data-stock-preview]')].some(n=>n.dataset.stockInformation===sku)){
    const summary=document.createElement('small');summary.dataset.stockChannel=button.dataset.stockChannel||'';summary.dataset.stockInformation=sku;summary.dataset.stockPreview='';summary.setAttribute('aria-live','polite');summary.textContent=sku+' · À venir : lecture en cours…';cell.prepend(summary);
    const prior=cache.get(sku);if(prior?.until>Date.now())show(summary,prior.data);else{watched.add(summary);visible.observe(summary);}
   }
   if(button.nextElementSibling?.hasAttribute('data-stock-information'))continue;
   const info=document.createElement('small');info.dataset.stockChannel=button.dataset.stockChannel||'';info.setAttribute('data-stock-information',sku);info.setAttribute('aria-live','polite');info.style.cssText='display:block;max-width:min(320px,calc(100vw - 80px));white-space:normal;overflow-wrap:anywhere;margin:4px 0 8px';info.textContent='À venir ERPLAIN : lecture au prochain affichage';button.after(info);
   const prior=cache.get(sku);if(prior?.until>Date.now())show(info,prior.data);else{watched.add(info);visible.observe(info);}
  }
 }
 new MutationObserver(refresh).observe(root,{childList:true,subtree:true});refresh();
 setInterval(()=>{if(document.hidden||document.getElementById('view-orders')?.hidden)return;for(const info of root.querySelectorAll('[data-stock-information][data-expires-at]'))if((info.dataset.stockChannel==='tender')===true&&Number(info.dataset.expiresAt)<=Date.now()){info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));}},60000);
})();

(()=>{
 const root=document.getElementById('order-rows');if(!root)return;
 const cache=new Map(),pending=new Map(),queue=[];let running=0;
 const format=value=>value===null||value===undefined?'non vérifiée':Number(value).toLocaleString('fr-FR');
 function receiptText(product){
  if(!(product?.incoming>0))return '';
  const schedule=product.incomingReceipts;
  const dates=(schedule?.receipts||[]).filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(r.quantity)&&r.quantity>0);
  if(!dates.length)return schedule?.status==='unverified'||!schedule?'Réception estimée : non vérifiée':'Réception estimée : date non renseignée';
  const text=dates.map(r=>r.date.slice(8,10)+'/'+r.date.slice(5,7)+'/'+r.date.slice(0,4)+' ('+format(r.quantity)+')').join(' ; ');
  return 'Réception estimée : '+text+(schedule.status==='verified'?'':' · autres quantités sans date vérifiée');
 }
 function html(data){
  return '<span>À venir ERPLAIN : '+esc(format(data.original.incoming))+'</span><br>'+(receiptText(data.original)?'<span>'+esc(receiptText(data.original))+'</span><br>':'')+
   (data.equivalentCount?'<span>Équivalent'+(data.equivalentCount>1?'s':'')+' enregistré'+(data.equivalentCount>1?'s':'')+' dans V3 : '+data.equivalents.map(e=>esc(e.sku)+' · '+(e.available===null?'stock non vérifié':esc(format(e.available))+' disponible'+(e.available>1?'s':''))).join(' ; ')+(data.equivalentCount>data.equivalents.length?' ; autres équivalents à consulter':'')+'</span>':'<span>Aucun équivalent enregistré dans V3</span>')+
   '<br><span>Emplacement V3 '+esc(data.locationId)+' · lu le '+esc(new Date(data.checkedAt).toLocaleString('fr-FR'))+'</span>';
 }
 const waitMs=20000;
 function loading(info,state){
  if(!info.isConnected)return;
  info.dataset.stockState=state;
  info.setAttribute('aria-busy','true');
  const text=state==='queued'?'lecture en attente · quantité non encore vérifiée':'lecture demandée à V3 · réponse attendue';
  info.textContent=(info.hasAttribute('data-stock-preview')?info.dataset.stockInformation+' · À venir : ':'À venir ERPLAIN : ')+text;
 }
 function failure(error){
  if(error?.status===401)return 'session V3 expirée · reconnectez-vous';
  if(error?.status>=400||['API_NETWORK_ERROR','API_READ_TIMEOUT'].includes(error?.code))return displayErrorMessage(error);
  return 'lecture indisponible';
 }
 function pump(){while(running<2&&queue.length){
  const entry=queue.shift();if(entry.done)continue;
  if(Date.now()>=entry.expires){entry.finish({error:true,reason:'lecture différée · aucune réponse stock obtenue'},Date.now()+60000);continue;}
  running++;entry.state='reading';for(const info of entry.nodes)loading(info,'reading');
  const remaining=Math.max(1,entry.expires-Date.now());
  Promise.race([api('/api/equivalences/stock-information?'+new URLSearchParams({sku:entry.sku,includeIncomingDates:1}),undefined,{timeoutMs:remaining}),entry.promise]).then(data=>{
   if(entry.done)return;
   if(!data?.original||!Array.isArray(data.equivalents)||!Number.isFinite(Date.parse(data.expiresAt)))throw Error('Réponse stock incomplète');
   entry.finish(data,Date.parse(data.expiresAt));
  }).catch(error=>entry.finish({error:true,reason:failure(error)},Date.now()+60000)).finally(()=>{running--;pump();});
 }}
 function load(sku,info){
  const prior=cache.get(sku);if(prior?.until>Date.now())return Promise.resolve(prior.data);
  let entry=pending.get(sku);
  if(!entry){
   entry={sku,state:'queued',nodes:new Set(),done:false,expires:Date.now()+waitMs};
   entry.promise=new Promise(resolve=>{entry.finish=(data,until)=>{
    if(entry.done)return;entry.done=true;clearTimeout(entry.timer);pending.delete(sku);
    const queued=queue.indexOf(entry);if(queued>=0)queue.splice(queued,1);
    cache.set(sku,{until,data});resolve(data);
   };});
   entry.timer=setTimeout(()=>entry.finish({error:true,reason:entry.state==='queued'?'lecture différée · aucune réponse stock obtenue':'délai de réponse dépassé'},Date.now()+60000),waitMs);
   pending.set(sku,entry);queue.push(entry);
  }
  if(info){entry.nodes.add(info);loading(info,entry.state);}
  pump();return entry.promise;
 }
 function show(info,data){
  if(!info.isConnected)return;
  info.dataset.expiresAt=String(cache.get(info.dataset.stockInformation)?.until||Date.now()+60000);
  info.setAttribute('aria-busy','false');info.dataset.stockState=data.error?'unavailable':'complete';
  const unknown=data.error||data.original?.incoming===null||data.original?.incoming===undefined;
  if(info.hasAttribute('data-stock-preview')){info.textContent=info.dataset.stockInformation+' · À venir : '+(unknown?'quantité non vérifiée'+(data.reason?' · '+data.reason:''):format(data.original.incoming)+(receiptText(data.original)?' · '+receiptText(data.original):''));return;}
  info.innerHTML=data.error?'À venir ERPLAIN : quantité non vérifiée · '+esc(data.reason||'lecture indisponible')+'<br>Équivalents V3 : lecture non obtenue':html(data);
  if(unknown){
   const retry=document.createElement('button');retry.type='button';retry.className='link-button';retry.dataset.stockRetry='';retry.textContent='Réessayer la lecture';
   retry.onclick=()=>{cache.delete(info.dataset.stockInformation);load(info.dataset.stockInformation,info).then(data=>show(info,data));};info.append(document.createElement('br'),retry);
  }
 }
 window.V3StockInformation={populate(info,sku){if(info.dataset.stockChannel==='tender')return window.V3StockInformationTender.populate(info,sku);info.dataset.stockInformation=sku;load(sku,info).then(data=>show(info,data));}};
 // Read only rows currently visible; hidden rows must not monopolize the two slots.
 const watched=new Set();
 const visible=new IntersectionObserver(entries=>{for(const {target:info,isIntersecting}of entries)if(isIntersecting&&info.isConnected&&!info.dataset.started){info.dataset.started='true';load(info.dataset.stockInformation,info).then(data=>show(info,data));visible.unobserve(info);watched.delete(info);}},{rootMargin:'0px'});
 function refresh(){
  for(const summary of root.querySelectorAll('[data-stock-preview]'))if(summary.parentElement?.dataset.fixedColumn!=='sku')summary.remove();
  for(const info of watched)if(!info.isConnected){visible.unobserve(info);watched.delete(info);}
  for(const button of root.querySelectorAll('.compact-problem[data-problem-type="stock"]')){
   if((button.dataset.stockChannel==='tender')!==false)continue;
   const sku=button.dataset.problemSku;if(!sku)continue;
   const row=button.closest('tr'),cell=row?.querySelector('td[data-fixed-column="sku"]');
   if(cell&&![...cell.querySelectorAll('[data-stock-preview]')].some(n=>n.dataset.stockInformation===sku)){
    const summary=document.createElement('small');summary.dataset.stockChannel=button.dataset.stockChannel||'';summary.dataset.stockInformation=sku;summary.dataset.stockPreview='';summary.setAttribute('aria-live','polite');summary.textContent=sku+' · À venir : quantité non encore lue';cell.prepend(summary);
    const prior=cache.get(sku);if(prior?.until>Date.now())show(summary,prior.data);else{watched.add(summary);visible.observe(summary);}
   }
   if(button.nextElementSibling?.hasAttribute('data-stock-information'))continue;
   const info=document.createElement('small');info.dataset.stockChannel=button.dataset.stockChannel||'';info.setAttribute('data-stock-information',sku);info.setAttribute('aria-live','polite');info.style.cssText='display:block;max-width:min(320px,calc(100vw - 80px));white-space:normal;overflow-wrap:anywhere;margin:4px 0 8px';info.textContent='À venir ERPLAIN : quantité non encore lue';button.after(info);
   const prior=cache.get(sku);if(prior?.until>Date.now())show(info,prior.data);else{watched.add(info);visible.observe(info);}
  }
 }
 new MutationObserver(refresh).observe(root,{childList:true,subtree:true});refresh();
 setInterval(()=>{if(document.hidden||document.getElementById('view-orders')?.hidden)return;for(const info of root.querySelectorAll('[data-stock-information][data-expires-at]'))if((info.dataset.stockChannel==='tender')===false&&Number(info.dataset.expiresAt)<=Date.now()&&!pending.has(info.dataset.stockInformation)&&info.getBoundingClientRect().bottom>0&&info.getBoundingClientRect().top<window.innerHeight){load(info.dataset.stockInformation,info).then(data=>show(info,data));}},60000);
})();
