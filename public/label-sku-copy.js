function skuCopyUnits(value){
 const text=String(value??'').trim();
 if(!/^(?:[1-9]\d*|[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3})+)$/.test(text))return '';
 const normalized=text.replace(/[ \u00a0\u202f]/g,'');
 return Number.isSafeInteger(Number(normalized))?normalized:'';
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-sku-copy]');if(!button)return;
 event.preventDefault();openSkuCopy(button.dataset.skuCopy).catch(e=>flash(e.message,true));
});
async function openSkuCopy(id){
 const data=await api('/api/labels/sku-copy?id='+encodeURIComponent(id));
 const d=resolutionDialog(data.documents.length?'Actualiser les SKU et unités sur l’étiquette — suivi inchangé':'Étiquettes existantes · aucun PDF',data.reference);
 d.body.innerHTML='<p>'+esc(data.message)+'</p><p>Cette action corrige le texte du PDF uniquement. Elle ne valide pas un remplacement de produit dans Erplain.</p><div data-sku-documents></div>';
 const container=d.body.querySelector('[data-sku-documents]');
 for(const doc of data.documents){
  const form=document.createElement('form');form.style.marginBottom='24px';
  const file='/api/labels/sku-copy/file?id='+encodeURIComponent(id)+'&key='+encodeURIComponent(doc.key);
  form.innerHTML='<h3>'+esc(doc.tracking||doc.kind)+'</h3><p><a target="_blank" rel="noopener" href="'+esc(file)+'">Télécharger le PDF actuel</a></p>'+(doc.grouped?'<p>Colis TEMU partagé entre plusieurs commandes : correction SKU groupée non disponible.</p>':doc.skus.length?doc.skus.map((sku,i)=>'<label>SKU actuel : '+esc(sku)+'<input name="sku'+i+'" value="'+esc(sku)+'" maxlength="100" required></label><label>Nombre d’unités affiché<input name="units'+i+'" type="number" min="1" step="1" required value="'+esc(skuCopyUnits((doc.mentions||[]).find(m=>m.sku===sku)?.units))+'"></label>').join('')+'<label style="display:flex;gap:8px;align-items:center"><input name="confirmed" type="checkbox" required style="width:18px;min-width:18px"> Je confirme les SKU et unités affichés sur le PDF ; les quantités du BC, du BL et du stock restent inchangées.</label><button type="submit">Enregistrer les SKU et unités — conserver le suivi</button>':'<p>Aucune zone SKU reconnue sur ce modèle. Le PDF reste disponible ci-dessus ; aucune nouvelle étiquette ne sera achetée.</p>')+'<p role="status" data-result></p>';
  container.append(form);let busy=false;
  form.onsubmit=async event=>{event.preventDefault();if(busy||!form.reportValidity())return;
   const replacements=doc.skus.map((from,i)=>({from,to:form.elements['sku'+i].value.trim(),units:Number(form.elements['units'+i].value)})).filter(x=>x.from!==x.to||String(x.units)!==skuCopyUnits((doc.mentions||[]).find(m=>m.sku===x.from)?.units));
   const status=form.querySelector('[data-result]');if(!replacements.length){status.textContent='Aucune mention modifiée. Vous pouvez télécharger le PDF actuel.';return;}
   busy=true;const submit=form.querySelector('button[type="submit"]');submit.disabled=true;
   try{const r=await api('/api/labels/sku-copy',{id,key:doc.key,token:doc.token,replacements,confirmed:form.elements.confirmed.checked});status.textContent=r.message;form.querySelectorAll('input').forEach(x=>x.disabled=true);const a=document.createElement('a');a.href=file;a.textContent='Télécharger l’étiquette corrigée';a.target='_blank';a.rel='noopener';status.append(document.createElement('br'),a);await orders();}
   catch(e){status.textContent=e.message;submit.disabled=false;}finally{busy=false;}
  };
 }
}


