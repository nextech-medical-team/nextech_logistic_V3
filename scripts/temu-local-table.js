// Injected exclusively by the loopback test server.
(()=>{
 const sync=document.getElementById('sync-tracking');if(sync){sync.textContent='Comparer les statuts PROD · lecture seule';sync.onclick=()=>{location.href='/status-preview';};}
 const tbody=document.getElementById('order-rows');
 const make=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
 const headers=()=>[...tbody.closest('table').querySelectorAll('thead th')];
 function cell(row,key){const index=headers().findIndex(h=>h.dataset.column===key);return index<0?null:row.children[index];}
 async function request(action,input){const r=await fetch('/api/local-temu/'+action,{method:'POST',headers:{'content-type':'application/json','x-local-test':'1'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok)throw Error(data.error||'Action TEMU impossible');return data;}
 async function openPurchase(o,recover=false){
  const dialog=document.createElement('dialog'),title=make('h3',(recover?'Récupérer':'Acheter')+' l’étiquette TEMU · '+o.reference),message=make('p','Chargement des boutiques…'),margin=make('p',''),select=document.createElement('select'),action=make('button',recover?'Récupérer':'Afficher le tarif'),close=make('button','Fermer');
  dialog.append(title,make('p','0,25 kg · 10 × 8 × 0,5 cm · dernier créneau proposé avant la limite TEMU'),select,message,margin,action,close);document.body.append(dialog);close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();action.disabled=true;
  let plan=null;
  select.onchange=()=>{plan=null;action.textContent=recover?'Récupérer':'Afficher le tarif';message.textContent='';margin.textContent='';};
  try{const r=await fetch('/api/local-temu/shops'),data=await r.json();if(!r.ok)throw Error(data.error);for(const s of data.shops){const option=make('option',(s.country||'Pays non renseigné')+' · boutique '+s.mall+(s.purchaseEnabled?'':' · lecture seule'));option.value=s.mall;select.append(option);}if(!select.options.length)throw Error('Aucune boutique TEMU accessible');message.textContent='Sélectionnez la boutique de cette commande.';action.disabled=false;}catch(e){message.textContent=e.message;}
  action.onclick=async()=>{
   action.disabled=true;select.disabled=true;close.disabled=true;
   try{
    if(recover){const result=await request('recover',{reference:o.reference,mall:select.value});message.textContent=result.error||'Récupération : '+result.status;await orders();}
    else if(!plan){plan=await request('prepare',{reference:o.reference,mall:select.value});const p=plan.request.sendRequestList[0],offer=plan.offers.find(x=>x.channelId===plan.selected);message.textContent=(offer?.shippingCompanyName||offer?.shipCompanyName||'Transporteur TEMU')+' · '+plan.amount+' '+plan.currency+' · '+(p.pickupStartTime?'Enlèvement : '+new Date(p.pickupStartTime*1000).toLocaleString('fr-FR'):'Expédition différée : '+plan.request.shipLaterLimitTime+' h');const m=plan.margin;
     const eur=v=>Number.isFinite(v)?v.toLocaleString('fr-FR',{style:'currency',currency:'EUR'}):'Indisponible';
     margin.textContent=m&&m.status!=='incomplete'?'Résultat HT : '+eur(m.profit)+' · Marge sur recettes : '+(Number.isFinite(m.margin)?(m.margin*100).toFixed(2)+' %':'—')+' · Produits : '+eur(m.purchase)+' · Transport fournisseur : '+eur(m.supplierShipping)+' · Étiquette HT : '+eur(m.shipping)+' · Contribution HT : '+eur(m.credit):'Marge indisponible : '+(m?.issues?.join(' ; ')||'Calcul non disponible');
     if(m?.warnings?.length)margin.textContent+=' · '+m.warnings.join(' ; ');
     action.textContent='Confirmer l’achat réel · '+plan.amount+' '+plan.currency;}
    else{const result=await request('buy',{reference:o.reference,planId:plan.id,amount:plan.amount,confirmPurchase:true});message.textContent=result.error||'Étiquette : '+result.status;await orders();plan=null;recover=true;action.textContent='Récupérer le PDF TEMU';}
   }catch(e){message.textContent=e.message;plan=null;action.textContent=recover?'Récupérer':'Afficher le tarif';await orders().catch(()=>{});}
   finally{action.disabled=false;select.disabled=false;close.disabled=false;}
  };
 }
 function render(){
  for(const row of tbody.rows){
   const id=row.querySelector('input[data-id]')?.dataset.id,o=typeof partialVisibleOrders!=='undefined'?partialVisibleOrders.get(id):null;if(!o)continue;
   const state=o.erp_test||{};
   for(const key of ['bc','bl']){const c=cell(row,key);if(!c)continue;c.replaceChildren(make('strong',state[key]?.label||'Non créé'));c.append(make('small','Erplain TEST 101406'+(state[key]?' · '+(state[key].status||'créé'):'')));}
   const transport=cell(row,'carrier');if(transport)transport.replaceChildren(make('span','TEMU'),make('small',o.temu_label?.status||'Étiquette à acheter'));
   const logistics=cell(row,'tracking');if(logistics)logistics.replaceChildren(make('span',(o.temu_label?.result?.packageInfoResultList||[]).map(p=>p.trackingNumber||p.trackingNo||'').filter(Boolean).join(', ')||'Non expédié'));
   const sku=cell(row,'sku');if(sku&&state.pricing?.items){sku.replaceChildren();for(const item of state.pricing.items.filter(l=>l.variant))sku.append(make('div',item.description+' ('+item.quantity+')'));}
   const label=cell(row,'label');if(label){
    label.replaceChildren();
    for(const d of o.temu_label?.documents||[]){const a=make('a','PDF TEMU · '+d.package);a.href=d.url;a.className='pdf-link';label.append(a);}
    if(o.temu_label?.error)label.append(make('small',o.temu_label.error));
    if(state.complete&&state.version===2&&!state.pending&&!state.error){
     const b=make('button','Acheter l’étiquette TEMU');b.onclick=()=>openPurchase(o);label.append(b);
     const r=make('button','Récupérer l’étiquette TEMU');r.onclick=()=>openPurchase(o,true);label.append(r);
     label.append(make('small','Achat réel · 0,25 kg · 10 × 8 × 0,5 cm'));
     if(o.temu_label&&o.temu_label.status!=='ready')b.disabled=true;
    }else{const a=make('a','Préparer BC et BL TEST');a.href='/erplain-test';label.append(a);}
   }
   const tracking=row.querySelector('[data-erplain-tracking]');if(tracking)tracking.replaceChildren(make('span',state.bl?state.bl.label+' · '+state.bl.status+' · TEST':'BL TEST non créé'));
   const hold=row.querySelector('[data-suspension-order]');if(hold)hold.replaceChildren(make('small',state.complete?'Parcours de test local · documents Erplain liés':'Import local · préparation TEST à faire'));
  }
  // Production action controls have no place in this loopback exercise.
  for(const b of document.querySelectorAll('button'))if(/PROD|Erplain LIVE/.test(b.textContent))b.hidden=true;
 }
 // Other order decorators insert the manager cell after the base async render.
 // Wait until that render and its promise continuations have finished.
 let frame=0;
 function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(render);}
 new MutationObserver(schedule).observe(tbody,{childList:true});
 const previousOrders=orders;
 orders=async function(...args){const result=await previousOrders.apply(this,args);schedule();return result;};
 const action=make('a','Préparer les commandes dans Erplain TEST');action.href='/erplain-test';action.className='pdf-link';document.querySelector('.batch')?.append(action);
 schedule();
})();
