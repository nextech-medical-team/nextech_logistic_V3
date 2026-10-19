async function addImportCorrectionActions(ctx,d){
 if(!['tender','samples','amazon'].includes(ctx.order.channel)||ctx.order.erp_live?.bc?.id||ctx.order.erp_live?.bl?.id||!ctx.order.source_payload?.row)return;
 try{const info=await api('/api/import-corrections/context?id='+encodeURIComponent(ctx.order.id));if(d.closed||!info.eligible)return;
  const section=document.createElement('section');section.setAttribute('aria-label','Corriger la commande importée');
  const note=document.createElement('p');note.textContent='Cette commande n’a pas de documents Erplain. Vous pouvez remplacer ses données depuis un fichier corrigé ou annuler son import dans V3.';section.append(note);
  for(const [action,label]of [['replace','Remplacer depuis un Excel corrigé'],['cancel','Annuler la commande importée']]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{d.modal.close();openImportCorrection(ctx.order.id,action,info).catch(e=>flash(e,true));};section.append(b);}d.body.append(section);
 }catch(e){if(!d.closed){const p=document.createElement('p');p.textContent='Actions sur l’import indisponibles : '+displayErrorMessage(e);d.body.append(p);}}
}
async function openImportCorrection(id,action,initial){
 const info=initial||await api('/api/import-corrections/context?id='+encodeURIComponent(id));if(!info.eligible)throw Error(info.reason);
 const d=resolutionDialog(action==='replace'?'Remplacer depuis un Excel corrigé':'Annuler la commande importée',info.reference);
 const form=document.createElement('form'),message=document.createElement('p');message.setAttribute('role','status');
 const intro=document.createElement('p');intro.textContent=action==='replace'?'Sélectionnez le fichier corrigé. Seule la commande '+info.reference+' sera remplacée. Les contrôles HT/TTC restent appliqués avant toute création Erplain.':'L’import sera annulé dans V3 et conservé dans l’historique. Cette action n’annule rien dans la plateforme source ni dans Erplain.';form.append(intro);
 let content=null,filename=null,revision=info.revision,requestId=crypto.randomUUID(),busy=false,previewed=action==='cancel';
 const preview=document.createElement('pre');preview.style.whiteSpace='pre-wrap';
 const confirmLabel=document.createElement('label'),confirm=document.createElement('input');confirm.type='checkbox';confirm.required=true;confirmLabel.append(confirm,document.createTextNode(action==='replace'?' Je confirme le remplacement des données de cette commande.':' Je confirme l’annulation de cette commande importée dans V3.'));
 const refLabel=document.createElement('label'),reference=document.createElement('input');reference.type='text';reference.required=true;reference.setAttribute('aria-label','Référence à confirmer');refLabel.append(document.createTextNode('Recopiez la référence '+info.reference),reference);
 const submit=document.createElement('button');submit.type='submit';submit.textContent=action==='replace'?'Valider le remplacement':'Valider l’annulation';submit.disabled=true;
 const validate=()=>submit.disabled=busy||!previewed||!confirm.checked||reference.value!==info.reference;confirm.onchange=validate;reference.oninput=validate;
 if(action==='replace'){
  const fileLabel=document.createElement('label'),file=document.createElement('input'),analyse=document.createElement('button');file.type='file';file.accept='.xlsx';file.required=true;file.setAttribute('aria-label','Excel corrigé');fileLabel.append(document.createTextNode('Fichier Excel corrigé'),file);analyse.type='button';analyse.textContent='Analyser le fichier corrigé';
  file.onchange=()=>{content=null;filename=null;previewed=false;confirm.checked=false;preview.textContent='';message.textContent='';requestId=crypto.randomUUID();validate();};
  analyse.onclick=async()=>{if(busy||!file.files[0])return;busy=true;analyse.disabled=true;file.disabled=true;validate();try{const selected=file.files[0];filename=selected.name;if(selected.size>18000000)throw Error('Le fichier dépasse 18 Mo.');const bytes=new Uint8Array(await selected.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));content=btoa(binary);message.textContent='Vérification des documents Erplain et lecture du fichier…';const r=await api('/api/import-corrections/preview',{id,filename,content});revision=r.revision;preview.textContent='Données actuelles\n'+JSON.stringify(r.before,null,2)+'\n\nDonnées du fichier corrigé\n'+JSON.stringify(r.after,null,2);message.textContent='Aperçu prêt. '+r.ignoredOrders+' autre(s) commande(s) du fichier seront ignorées. Aucun document créé.';previewed=true;}catch(e){previewed=false;message.textContent=displayErrorMessage(e);}finally{busy=false;analyse.disabled=false;file.disabled=false;validate();}};
  form.append(fileLabel,analyse,preview);
 }
 form.append(refLabel,confirmLabel,submit,message);d.body.append(form);
 form.onsubmit=async e=>{e.preventDefault();if(busy||submit.disabled)return;busy=true;form.querySelectorAll('input,button').forEach(x=>x.disabled=true);message.textContent='Vérification et enregistrement…';try{
  const r=await api('/api/import-corrections/apply',{id,action,requestId,revision,reference:reference.value,confirmed:confirm.checked,...(action==='replace'?{filename,content}:{})});
  message.textContent=r.message;form.querySelectorAll('input,button').forEach(x=>x.disabled=true);await orders();
  if(action==='replace'){const resume=document.createElement('button');resume.type='button';resume.textContent='Reprendre les contrôles de la commande';resume.onclick=async()=>{d.modal.close();await openRemainingProblem(id);};form.append(resume);}else{const close=document.createElement('button');close.type='button';close.textContent='Voir la liste des commandes';close.onclick=()=>d.modal.close();form.append(close);}
 }catch(error){message.textContent=displayErrorMessage(error);busy=false;form.querySelectorAll('input,button').forEach(x=>x.disabled=false);validate();}};
}
