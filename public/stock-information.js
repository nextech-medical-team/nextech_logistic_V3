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
 function show(info,data){if(!info.isConnected)return;info.dataset.expiresAt=String(cache.get(info.dataset.stockInformation)?.until||Date.now()+60000);if(data.error){info.innerHTML='À venir ERPLAIN : lecture indisponible ou différée · équivalents V3 : non vérifiés<br><button type="button" class="link-button" data-stock-retry>Réessayer la lecture</button>';info.querySelector('[data-stock-retry]').onclick=()=>{cache.delete(info.dataset.stockInformation);info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));};}else info.innerHTML=html(data);}
 window.V3StockInformation={populate(info,sku){info.dataset.stockInformation=sku;info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(sku).then(data=>show(info,data));}};
 // Read only rows currently visible; hidden rows must not monopolize the two slots.
 const watched=new Set();
 const visible=new IntersectionObserver(entries=>{for(const {target:info,isIntersecting}of entries)if(isIntersecting&&info.isConnected&&!info.dataset.started){info.dataset.started='true';info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));visible.unobserve(info);watched.delete(info);}},{rootMargin:'0px'});
 function refresh(){
  for(const info of watched)if(!info.isConnected){visible.unobserve(info);watched.delete(info);}
  for(const button of root.querySelectorAll('.compact-problem[data-problem-type="stock"]')){
   const sku=button.dataset.problemSku;if(!sku||button.nextElementSibling?.hasAttribute('data-stock-information'))continue;
   const info=document.createElement('small');info.setAttribute('data-stock-information',sku);info.setAttribute('aria-live','polite');info.style.cssText='display:block;max-width:min(320px,calc(100vw - 80px));white-space:normal;overflow-wrap:anywhere;margin:4px 0 8px';info.textContent='À venir ERPLAIN : lecture au prochain affichage';button.after(info);
   const prior=cache.get(sku);if(prior?.until>Date.now())show(info,prior.data);else{watched.add(info);visible.observe(info);}
  }
 }
 new MutationObserver(refresh).observe(root,{childList:true,subtree:true});refresh();
 setInterval(()=>{if(document.hidden||document.getElementById('view-orders')?.hidden)return;for(const info of root.querySelectorAll('[data-stock-information][data-expires-at]'))if(Number(info.dataset.expiresAt)<=Date.now()){info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';load(info.dataset.stockInformation).then(data=>show(info,data));}},60000);
})();
