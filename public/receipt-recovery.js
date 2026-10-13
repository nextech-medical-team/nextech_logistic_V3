(() => {
 'use strict';
 const $=id=>document.getElementById(id),states={queued:'Analyse en attente',reading:'Lecture ERPLAIN en cours',ready:'Analyse disponible',applying:'Préparation en cours',finished:'Traitement terminé · vérifier les résultats',failed:'Analyse impossible',eligible:'Admissible',blocked:'À traiter',documents:'Documents existants',selected:'En attente',preparing:'Préparation du BL',label_pending:'Étiquette en cours',complete:'BL et étiquette disponibles',label_action_required:'Action TEMU requise'};
 let current=null,timer=null,busy=false,user=null,selected=new Set(),previewRequest=null;
 const date=v=>v?new Date(v).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'';
 function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
 function error(e){$('receipt-error').textContent=e.message;$('receipt-error').hidden=false;}
 async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(r.status===401)throw Error('Session expirée : connectez-vous depuis la page V3 puis revenez aux réceptions.');const j=await r.json();if(!r.ok)throw Error(j.error||'Demande indisponible');return j;}
 function selection(){const eligible=current?.state==='ready'&&current.plan?.coverage?.complete&&['admin','manager'].includes(user?.role);$('receipt-execute').disabled=!eligible||selected.size===0||busy;$('receipt-select-all').disabled=!eligible;$('receipt-execute').textContent=selected.size?'Préparer '+selected.size+' commande'+(selected.size>1?'s':''):'Préparer les commandes sélectionnées';}
 function render(r){
  const changed=current?.id!==r.id;current=r;if(changed)selected.clear();$('receipt-message').textContent=states[r.state]||r.state;$('receipt-results').hidden=!r.plan;
  if(r.error)error(Error(r.error));if(!r.plan){selection();return;}
  $('receipt-title').textContent='Réception '+r.plan.receipts.map(x=>x.label).join(', ');$('receipt-date').textContent='Stock vérifié le '+date(r.plan.checkedAt)+' · '+r.plan.coverage.orders+' commandes examinées';
  $('receipt-metrics').replaceChildren(...[['matched','Commandes concernées'],['eligible','Admissibles'],['blocked','À traiter'],['documents','Documents existants']].map(([k,t])=>{const e=node('div',undefined,'metric');e.append(node('strong',String(r.plan.counts[k])),node('span',t));return e;}));
  const ul=node('ul');for(const l of r.plan.received)ul.append(node('li',l.sku+' · '+l.quantity+' unités · '+l.location));$('receipt-products').replaceChildren(ul);
  const canSelect=r.state==='ready'&&r.plan.coverage.complete&&['admin','manager'].includes(user?.role),cards=[];
  for(const row of r.plan.rows){
   const card=node('article',undefined,'order'),heading=node('div',undefined,'order-heading'),label=node('label'),check=node('input');check.type='checkbox';check.setAttribute('aria-label','Sélectionner '+row.reference);check.disabled=!canSelect||row.status!=='eligible';check.checked=selected.has(row.id);check.addEventListener('change',()=>{check.checked?selected.add(row.id):selected.delete(row.id);selection();});label.append(check,node('strong',row.reference));const state=row.item?.state||row.status;heading.append(label,node('span',states[state]||state,'badge '+state));card.append(heading,node('p',row.channel.toUpperCase()+' · BC '+(row.bc||'absent')+(row.currentBl?' · BL '+row.currentBl.label+' ('+row.currentBl.status+')':''),'order-meta'));
   const reason=row.item?.error||row.item?.job?.error||row.reason;if(reason)card.append(node('p',reason,'reason'));
   if(row.labelError)card.append(node('p','TEMU : '+row.labelError,'reason'));
   card.append(node('div',(row.needs||[]).map(l=>l.sku+' × '+l.quantity+' · lieu '+l.locationId+(l.tracked?' · disponible '+l.available+' / réservé au BC '+l.reserved:' · stock non suivi')).join(' ; '),'products'));
   if(row.labels?.length){const links=node('div',undefined,'downloads');for(const pdf of row.labels){const a=node('a',pdf.name);a.href=pdf.url;a.target='_blank';a.rel='noopener';links.append(a);}card.append(links);}else if(state==='label_action_required')card.append(node('p','Ouvrez le parcours TEMU dans V3 pour traiter cette étiquette.','muted'));
   cards.push(card);
  }
  $('receipt-orders').replaceChildren(...cards);$('receipt-empty').hidden=cards.length!==0;$('receipt-select-all').checked=selected.size>0&&selected.size===r.plan.rows.filter(o=>o.status==='eligible').length;
  $('receipt-execution-note').textContent=r.plan.coverage.complete?'Les quantités sont réparties par priorité puis par ancienneté. Le stock est relu avant chaque reprise.':'Lecture incomplète : '+r.plan.coverage.errors+' commande(s) non vérifiée(s). Relancez l’analyse avant tout traitement.';
  selection();
 }
 async function load(id){if(busy)return;busy=true;try{$('receipt-error').hidden=true;render(await api('/api/receipts/recovery/status?id='+encodeURIComponent(id)));}catch(e){error(e);}finally{busy=false;selection();clearTimeout(timer);if(current&&['queued','reading','applying'].includes(current.state))timer=setTimeout(()=>load(current.id),2500);}}
 async function history(){const h=await api('/api/receipts/recovery');$('receipt-history').replaceChildren(...h.rows.map(r=>{const b=node('button',r.number+' · '+(states[r.state]||r.state)+' · '+date(r.created_at));b.type='button';b.addEventListener('click',()=>load(r.id));return b;}));if(!h.rows.length)$('receipt-history').append(node('p','Aucune analyse enregistrée.','muted'));}
 $('receipt-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;$('receipt-analyze').disabled=true;$('receipt-error').hidden=true;try{const number=$('receipt-number').value.trim();if(previewRequest?.number!==number||previewRequest.completed)previewRequest={number,requestId:crypto.randomUUID()};const r=await api('/api/receipts/recovery/preview',previewRequest);previewRequest.completed=true;current=null;busy=false;await load(r.id);await history();}catch(e){error(e);}finally{busy=false;$('receipt-analyze').disabled=false;selection();}});
 $('receipt-refresh').addEventListener('click',()=>current&&load(current.id));
 $('receipt-select-all').addEventListener('change',()=>{selected=$('receipt-select-all').checked?new Set(current.plan.rows.filter(r=>r.status==='eligible').map(r=>r.id)):new Set();render(current);});
 $('receipt-execute').addEventListener('click',async()=>{if(busy||!selected.size)return;busy=true;selection();try{await api('/api/receipts/recovery/execute',{id:current.id,ids:[...selected]});busy=false;await load(current.id);await history();}catch(e){error(e);}finally{busy=false;selection();}});
 api('/api/me').then(async u=>{user=u;await history();}).catch(error);
 window.addEventListener('pagehide',()=>clearTimeout(timer));
})();
