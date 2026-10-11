(() => {
  'use strict';
  const app=document.getElementById('app'),main=app?.querySelector('main');
  if(!app||!main)return;
  const panel=document.createElement('section');panel.id='movement-watch-panel';panel.className='panel padded';panel.hidden=true;panel.setAttribute('aria-label','Vérification du suivi des colis TEMU');
  const title=document.createElement('h2');title.textContent='Vérification du suivi des colis TEMU';
  const summary=document.createElement('p');summary.setAttribute('role','status');
  const cadence=document.createElement('p');cadence.textContent='Suivi du déplacement des colis relu toutes les 15 minutes · contrôle de la surveillance toutes les 5 minutes · alerte après une heure. Les suspensions et les étiquettes sont préservées. Un statut de préparation ne certifie pas une absence physique de mouvement.';
  const details=document.createElement('details'),toggle=document.createElement('summary'),list=document.createElement('div');toggle.textContent='Commandes suivies et prochaines vérifications';details.append(toggle,list);panel.append(title,summary,cadence,details);
  const style=document.createElement('style');style.textContent='#movement-watch-panel{margin-bottom:18px}#movement-watch-panel details{margin-top:12px}#movement-watch-panel article{padding:12px 0;border-top:1px solid #dbe5e5;overflow-wrap:anywhere}#movement-watch-panel p{line-height:1.5}#movement-watch-panel .movement-watch-alert{color:#8a4500;font-weight:700}#movement-watch-panel button{margin-top:8px;max-width:100%}';document.head.append(style);main.querySelector('header')?.after(panel);
  let busy=false,lastKey='';
  const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('fr-FR',{timeZone:'Europe/Paris'}):'Pas encore effectuée';
  const isOld=value=>!value||!Number.isFinite(Date.parse(value))||Date.now()-Date.parse(value)>10*60*1000;
  const line=(parent,text,cls)=>{const p=document.createElement('p');p.textContent=text;if(cls)p.className=cls;parent.append(p);};
  async function refresh(){
    if(busy||app.hidden)return;busy=true;
    try{
      const response=await fetch('/api/movement-watch',{credentials:'same-origin',cache:'no-store'});
      if([401,403].includes(response.status)){panel.hidden=true;return;}
      if(!response.ok)throw Error('Lecture de la surveillance indisponible');
      const data=await response.json();if(!Array.isArray(data.rows))throw Error('État de surveillance incomplet');
      const errors=data.rows.filter(r=>r.overdue||r.stalled).length,alerts=data.rows.filter(r=>r.alerted_at&&r.reason_code!=='preparation_only_observed').length;
      const unhealthy=isOld(data.watchdog?.lastSuccessAt),key=JSON.stringify([data.rows,unhealthy]);
      panel.hidden=data.rows.length===0&&!unhealthy;
      if(key===lastKey)return;lastKey=key;
      summary.textContent=`${data.rows.length} commandes suivies · ${alerts} alertes ouvertes · ${errors} vérifications en retard.`+(unhealthy?' Contrôle de la surveillance absent ou en retard : intervention nécessaire.':'');
      summary.className=unhealthy||errors?'movement-watch-alert':'';list.replaceChildren();
      for(const row of data.rows){const card=document.createElement('article'),heading=document.createElement('h3');heading.textContent=row.reference;card.append(heading);
        line(card,row.detail||'Première vérification programmée');
        line(card,'Dernière vérification : '+date(row.last_check_at));
        line(card,'Prochaine vérification : '+date(row.next_check_at));
        if(row.overdue||row.stalled)line(card,'Vérification en retard ou interrompue : surveillance à contrôler.','movement-watch-alert');
        if(row.alerted_at&&row.reason_code!=='preparation_only_observed')line(card,'Vérification du suivi à résoudre : consulter le motif ci-dessus.','movement-watch-alert');
        line(card,'Prochaine étape : '+(row.reason_code==='preparation_only_observed'?'relire le suivi à l’échéance, sans bloquer la préparation des BC et BL.':'poursuivre la vérification du suivi ; les contrôles métier restent indépendants.'));
        const button=document.createElement('button');button.type='button';button.textContent='Voir la commande';button.addEventListener('click',()=>{const search=document.getElementById('search'),ordersButton=app.querySelector('button[data-view="orders"]');ordersButton?.click();if(search){search.value=row.reference;search.dispatchEvent(new Event('input',{bubbles:true}));search.focus();search.scrollIntoView({block:'center'});}});card.append(button);list.append(card);
      }
    }catch{panel.hidden=false;summary.textContent='Surveillance momentanément indisponible : aucune reprise déduite de cette erreur.';summary.className='movement-watch-alert';lastKey='';}
    finally{busy=false;}
  }
  new MutationObserver(()=>{if(app.hidden)panel.hidden=true;else refresh();}).observe(app,{attributes:true,attributeFilter:['hidden']});
  refresh();setInterval(refresh,30000);
})();
