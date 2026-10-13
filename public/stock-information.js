(()=>{
 const root=document.getElementById('order-rows');if(!root)return;
 const cache=new Map(),pending=new Map(),queue=[];let running=0;
 const format=value=>value===null||value===undefined?'non vérifiée':Number(value).toLocaleString('fr-FR');
 function html(data){
  return '<span>À venir ERPLAIN : '+esc(format(data.original.incoming))+'</span><br>'+
   (data.equivalentCount?'<span>Équivalent'+(data.equivalentCount>1?'s':'')+' enregistré'+(data.equivalentCount>1?'s':'')+' dans V3 : '+data.equivalents.map(e=>esc(e.sku)+' · '+(e.available===null?'stock non vérifié':esc(format(e.available))+' disponible'+(e.available>1?'s':''))).join(' ; ')+(data.equivalentCount>data.equivalents.length?' ; autres équivalents à consulter':'')+'</span>':'<span>Aucun équivalent enregistré dans V3</span>')+
   '<br><span>Emplacement V3 '+esc(data.locationId)+' · lu le '+esc(new Date(data.checkedAt).toLocaleString('fr-FR'))+'</span>';
 }
 function pump(){while(running<2&&queue.length){const {sku,resolve}=queue.shift();running++;api('/api/equivalences/stock-information?'+new URLSearchParams({sku})).then(data=>{cache.set(sku,{until:Date.parse(data.expiresAt),data});resolve(data);},()=>{const data={error:true};cache.set(sku,{until:Date.now()+60000,data});resolve(data);}).finally(()=>{running--;pending.delete(sku);pump();});}}
 function load(sku){const prior=cache.get(sku);if(prior?.until>Date.now())return Promise.resolve(prior.data);if(pending.has(sku))return pending.get(sku);const promise=new Promise(resolve=>queue.push({sku,resolve}));pending.set(sku,promise);pump();return promise;}
 function refresh(){
  for(const button of root.querySelectorAll('.compact-problem[data-problem-type="stock"]')){
   const sku=button.dataset.problemSku;if(!sku||button.nextElementSibling?.hasAttribute('data-stock-information'))continue;
   const info=document.createElement('small');info.setAttribute('data-stock-information',sku);info.setAttribute('aria-live','polite');info.style.cssText='display:block;max-width:min(320px,calc(100vw - 80px));white-space:normal;overflow-wrap:anywhere;margin:4px 0 8px';info.textContent='À venir ERPLAIN et équivalents V3 : lecture en cours…';button.after(info);
   load(sku).then(data=>{if(!info.isConnected)return;info.dataset.expiresAt=String(cache.get(sku)?.until||Date.now()+60000);if(data.error)info.textContent='À venir ERPLAIN : non vérifiée · équivalents V3 : non vérifiés';else info.innerHTML=html(data);});
  }
 }
 new MutationObserver(refresh).observe(root,{childList:true,subtree:true});refresh();
 setInterval(()=>{if(document.hidden||document.getElementById('view-orders')?.hidden)return;for(const info of root.querySelectorAll('[data-stock-information][data-expires-at]'))if(Number(info.dataset.expiresAt)<=Date.now())info.remove();refresh();},60000);
})();
