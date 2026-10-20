const parcelDrafts2005=new Map();
function erpStatusText(status){return ({active:'Actif',pending:'En attente',unpublished:'Brouillon',make_the_shipment:'À expédier',in_preparation:'En préparation',ready_to_ship:'Prêt à livrer',shipped:'Expédié',delivered:'Livré',completed:'Terminé',cancelled:'Annulé',closed:'Clôturé'})[status]||status||'Statut à actualiser';}
function renderTransportStats(rows,summary){const sum=rows.reduce((n,r)=>n+Number(r.orders),0),titles={gls:'GLS',gofo:'GOFO',mixed:'GLS et GOFO',temu:'TEMU'};const lines=rows.map(r=>'<div class="transport-stat-row"><span>'+esc(titles[r.family]||r.family)+'</span><span>'+Number(r.orders).toLocaleString('fr-FR')+'</span><span>'+(sum?100*Number(r.orders)/sum:0).toLocaleString('fr-FR',{maximumFractionDigits:1})+' %</span></div>');$('transport-statistics').innerHTML='<strong>Commandes avec PDF</strong><div class="transport-stat-list">'+lines.join('')+'</div><small>Filtres actuels · '+sum.toLocaleString('fr-FR')+' commandes uniques</small>';if(summary)for(const k of ['total','blocked','labels','delivered'])$('stat-'+k).textContent=Number(summary[k]||0).toLocaleString('fr-FR');}

const transportSummary=document.createElement('div');transportSummary.id='transport-statistics';transportSummary.className='panel padded';const oldDeliveryMetric=$('stat-delivered').closest('article');oldDeliveryMetric.hidden=true;oldDeliveryMetric.parentElement.append(transportSummary);

const previousShow2005=show;show=async function(view){await previousShow2005(view);document.querySelectorAll('nav [data-view]').forEach(b=>{const active=b.dataset.view===currentView;b.classList.toggle('active',active);b.setAttribute('aria-current',active?'page':'false');});};
Object.assign(managerTitles,{shopify:'NEXTECH · Tous',shopify_boutique:'NEXTECH BOUTIQUE',shopify_relay:'NEXTECH RELAIS'});for(const v of ['shopify_boutique','shopify_relay'])if(![...$('channel').options].some(o=>o.value===v))$('channel').add(new Option(managerTitles[v],v));for(const o of $('channel').options)o.textContent=managerTitles[o.value]||o.textContent;
for(const o of $('status').options){const names={simulated:'À générer',waiting_catalog:'Poids en attente',sandbox_ready:'PDF disponible · TEST',production_ready:'PDF disponible · PROD',awaiting_pdf:'PDF attendu',review:'À vérifier'};o.textContent=names[o.value]||o.textContent;}Object.assign(labels,{simulated:'À générer'});
const inlineParcelOrders2005=new Map();
function inlineTracking2005(o){
 inlineParcelOrders2005.set(o.id,o);
 const tracks=[...(o.carrier_job?.tracking||[]).map((tracking,index)=>({tracking,index})),...(o.extra_parcels||[]).filter(p=>p.status==='ready'&&p.tracking).map(p=>({tracking:p.tracking,parcelId:p.id}))];
 return tracks.map((t,i)=>'<span class="parcel-inline-control" data-inline-track="'+esc(o.id)+'" data-track-position="'+i+'">'+'<span class="parcel-inline-value">'+esc(t.tracking)+'</span><button class="parcel-inline-pencil" type="button" data-track-pencil="'+i+'" aria-label="Modifier le suivi '+esc(t.tracking)+'" title="Modifier le numéro de suivi">✎</button></span>').join('');
}
function visibleExtraParcels2005(o){const extras=o.extra_parcels||[];return extras.filter(p=>p.status!=='cancelled'&&!(p.status==='failed'&&extras.some(x=>x.status==='ready'&&x.parcel_index===p.parcel_index)));}
function inlineLabelCount2005(o){
 inlineParcelOrders2005.set(o.id,o);
 if(o.partial_mode||!o.document_count||!['gls','gls_pharma','gls_shop','gofo'].includes(o.carrier))return '';
 const extras=o.extra_parcels||[],ready=Number(o.document_count)+extras.filter(p=>p.status==='ready').length,waiting=extras.filter(p=>!['ready','failed','cancelled'].includes(p.status)),pending=waiting.length>0;
 return '<div class="parcel-count-container"><div class="parcel-inline-control" data-inline-count="'+esc(o.id)+'"><span class="parcel-inline-value">'+ready+' étiquette'+(ready>1?'s':'')+'</span><button type="button" class="parcel-inline-pencil" data-count-pencil '+(pending?'disabled':'')+' aria-label="Modifier le nombre total d’étiquettes" title="Modifier le nombre total d’étiquettes">✎</button></div>'+(pending?'<small>'+ready+' disponible(s) · '+(ready+waiting.length)+' demandée(s) · création en cours</small>':'')+'</div>';
}
function inlineEditor2005(host,{value,type,min,max,label,save}){
 if(host.querySelector('input'))return;
 const saved=[...host.childNodes];host.dataset.inlineEditing='true';host.replaceChildren();
 const input=document.createElement('input');input.type=type;input.value=value;input.style.cssText='width:100%;min-width:0;box-sizing:border-box';input.setAttribute('aria-label',label);if(min!=null)input.min=min;if(max!=null)input.max=max;
 const ok=document.createElement('button');ok.type='button';ok.textContent='Valider';
 const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Annuler';
 const message=document.createElement('small');message.setAttribute('role','status');
 cancel.onclick=()=>{delete host.dataset.inlineEditing;host.replaceChildren(...saved);};
 ok.onclick=async()=>{ok.disabled=true;cancel.disabled=true;input.disabled=true;message.textContent='Enregistrement…';try{await save(input.value);delete host.dataset.inlineEditing;host.replaceChildren(...saved);await orders();}catch(e){message.textContent=displayErrorMessage(e);ok.disabled=false;cancel.disabled=false;input.disabled=false;}};
 input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();ok.click();}if(e.key==='Escape'&&!cancel.disabled)cancel.click();};
 host.append(input,ok,cancel,message);input.focus();input.select();
}
document.addEventListener('click',e=>{
 const track=e.target.closest('[data-track-pencil]'),count=e.target.closest('[data-count-pencil]');if(!track&&!count)return;e.preventDefault();e.stopPropagation();
 if(track){const host=track.closest('[data-inline-track]'),o=inlineParcelOrders2005.get(host.dataset.inlineTrack);if(!o)return;const all=[...(o.carrier_job?.tracking||[]).map((tracking,index)=>({tracking,index})),...(o.extra_parcels||[]).filter(p=>p.status==='ready'&&p.tracking).map(p=>({tracking:p.tracking,parcelId:p.id}))],t=all[Number(track.dataset.trackPencil)];
 inlineEditor2005(host,{value:t.tracking,type:'text',label:'Nouveau numéro de suivi',save:async value=>{await api('/api/tracking/edit',{id:o.id,...t,expected:t.tracking,tracking:value});flash('Suivi modifié. Étiquette existante conservée.');}});
 }else{const host=count.closest('[data-inline-count]'),o=inlineParcelOrders2005.get(host.dataset.inlineCount);if(!o)return;const current=(o.carrier_job?.tracking?.length||o.document_count)+(o.extra_parcels||[]).filter(p=>!['failed','cancelled'].includes(p.status)).length;
 inlineEditor2005(host,{value:current,type:'number',min:current,max:current+100,label:'Nombre total d’étiquettes souhaité',save:async value=>{const total=Number(value);if(!Number.isInteger(total)||total<current||total>current+100)throw Error('Saisir un total entre '+current+' et '+(current+100)+'. Les étiquettes existantes sont conservées.');if(total===current)return;const key=o.id+':'+current+':'+total;let requestId=parcelDrafts2005.get(key);if(!requestId){requestId=crypto.randomUUID();parcelDrafts2005.set(key,requestId);}await api('/api/parcels/add',{id:o.id,carrier:o.carrier,count:total-current,expectedTotal:current,requestId});parcelDrafts2005.delete(key);flash((total-current)+' étiquette(s) complémentaire(s) en création.');}});
 }
});

const missingExport=document.createElement('a');missingExport.className='button';missingExport.href='/api/mappings/missing/export';missingExport.textContent='Exporter tous les SKU à mapper';$('view-mappings').querySelector('.panel').prepend(missingExport);

$('clear-filters').classList.add('primary');$('reload').classList.add('primary');
const erpRefreshButton=document.createElement('button');erpRefreshButton.textContent='Actualiser les statuts Erplain';$('reload').after(erpRefreshButton);erpRefreshButton.onclick=async()=>{erpRefreshButton.disabled=true;try{const r=await api('/api/erplain/status/refresh',{});flash(r.message);await orders();}catch(e){flash(e,true);}finally{erpRefreshButton.disabled=false;}};

$('status').add(new Option('Tous les problèmes','__problems'));
const allProblemsButton=document.createElement('button');allProblemsButton.id='all-problems';allProblemsButton.textContent='Tous les problèmes';allProblemsButton.title='Afficher les commandes bloquées, les erreurs transporteurs, Erplain et colis supplémentaires';allProblemsButton.className='primary';allProblemsButton.onclick=()=>{resetFilters();if($('problem-type'))$('problem-type').selectedIndex=-1;$('status').value='__problems';compactFilters.forEach(x=>x.sync());show('orders');};$('clear-filters').after(allProblemsButton);

$('routing-form').insertAdjacentHTML('afterbegin','<fieldset><legend>GLS international · destinations hors France</legend><p>GOFO est réservé à FR. Hors France : GLS MONO, produit PARCEL, nombre de colis selon le poids Erplain, 0,25 kg par étiquette.</p><label style="display:flex;align-items:center;gap:10px"><input style="width:auto;min-width:0" type="checkbox" id="routing-int-flex" checked> FlexDelivery si email disponible</label><label>Incoterm<select id="routing-int-incoterm"><option value="">Non renseigné</option><option value="DAP">DAP</option><option value="DDP">DDP</option></select></label><p>V2 : PARCEL ; reprise avec DAP uniquement si GLS demande explicitement un Incoterm. Choisir un Incoterm définit les modalités douanières ; aucun changement automatique des documents Erplain.</p></fieldset>');

