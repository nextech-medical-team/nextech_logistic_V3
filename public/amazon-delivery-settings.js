const amazonDepartmentCodes=[...Array.from({length:19},(_,i)=>String(i+1).padStart(2,'0')),'2A','2B',...Array.from({length:75},(_,i)=>String(i+21)), '971','972','973','974','975','976','977','978','984','986','987','988'];
$('routing-form').querySelector('button.primary').insertAdjacentHTML('beforebegin',`<fieldset id="amazon-delivery-settings">
 <legend>Amazon · départements et délais de livraison</legend>
 <details id="amazon-gofo-exclusions" class="amazon-department-picker">
 <summary><span>Départements exclus de GOFO</span><strong id="amazon-gofo-summary" aria-live="polite">Aucun département exclu</strong></summary>
 <div class="amazon-department-grid">${amazonDepartmentCodes.map(code=>`<label><input type="checkbox" name="gofoExcludedDepartments[]" value="${code}" aria-label="Exclure le département ${code} de GOFO"><span>${code}</span></label>`).join('')}</div>
 </details>
 <p>Pour les prochaines préparations Amazon, une destination exclue passe de GOFO à GLS. Un département inconnu ne déclenche aucune bascule. Les étiquettes déjà créées sont conservées.</p>
 <label>Code postal de départ GOFO<input id="amazon-origin-gofo" inputmode="numeric" maxlength="5" pattern="[0-9]{5}" placeholder="À renseigner"></label>
 <label>Code postal de départ GLS<input id="amazon-origin-gls" inputmode="numeric" maxlength="5" pattern="[0-9]{5}" placeholder="À renseigner"></label>
 <p>Renseignez les délais validés par vos transporteurs pour chaque entrepôt et département. Un jour ouvré correspond à l’indication 24h, deux jours ouvrés à 48h ; ce sont des estimations, pas des heures calendaires garanties. Sans règle correspondante, la commande affiche « Délai de livraison à confirmer ».</p>
 <div class="table-wrap"><table><thead><tr><th>Transporteur</th><th>Code postal de départ</th><th>Département destinataire</th><th>Délai en jours ouvrés</th><th></th></tr></thead><tbody id="amazon-delivery-rows"></tbody></table></div>
 <button type="button" id="amazon-delivery-add">Ajouter un délai Amazon</button>
</fieldset>`);
function addAmazonDeliveryRow(rule={}){
 const tr=document.createElement('tr');
 tr.innerHTML='<td><select name="carrier"><option value="gls"'+(rule.carrier==='gls'?' selected':'')+'>GLS</option><option value="gofo"'+(rule.carrier==='gofo'?' selected':'')+'>GOFO</option></select></td>'+
  '<td><input name="originPostal" aria-label="Départ du délai" inputmode="numeric" maxlength="5" pattern="[0-9]{5}" required value="'+esc(rule.originPostal||'')+'"></td>'+
  '<td><input name="department" aria-label="Département du délai" maxlength="3" required value="'+esc(rule.department||'')+'"></td>'+
  '<td><input name="workDays" aria-label="Jours ouvrés du délai" type="number" min="1" max="10" step="1" required value="'+esc(rule.workDays??'')+'"></td>'+
  '<td><button type="button">Supprimer ce délai</button></td>';
 tr.querySelector('button').onclick=()=>tr.remove();$('amazon-delivery-rows').append(tr);
}
function renderAmazonDeliverySettings(config){
 const selected=new Set(config.gofoExcludedDepartments||[]);
 for(const input of $('amazon-gofo-exclusions').querySelectorAll('input'))input.checked=selected.has(input.value);
 updateAmazonDepartmentSummary();
 for(const carrier of ['gls','gofo'])$('amazon-origin-'+carrier).value=config.amazonDeliveryOrigins?.[carrier]||'';
 $('amazon-delivery-rows').replaceChildren();(config.amazonDeliveryRules||[]).forEach(addAmazonDeliveryRow);
}
function readAmazonDeliverySettings(){
 return {gofoExcludedDepartments:[...$('amazon-gofo-exclusions').querySelectorAll('input:checked')].map(input=>input.value),amazonDeliveryOrigins:{gls:$('amazon-origin-gls').value.trim(),gofo:$('amazon-origin-gofo').value.trim()},amazonDeliveryRules:[...$('amazon-delivery-rows').children].map(tr=>({carrier:tr.querySelector('[name=carrier]').value,originPostal:tr.querySelector('[name=originPostal]').value.trim(),department:tr.querySelector('[name=department]').value.trim(),workDays:Number(tr.querySelector('[name=workDays]').value)}))};
}
$('amazon-delivery-add').onclick=()=>addAmazonDeliveryRow();

function updateAmazonDepartmentSummary(){
 const selected=[...$('amazon-gofo-exclusions').querySelectorAll('input:checked')].map(input=>input.value);
 $('amazon-gofo-summary').textContent=selected.length?selected.join(', '):'Aucun département exclu';
}
$('amazon-gofo-exclusions').addEventListener('change',updateAmazonDepartmentSummary);
