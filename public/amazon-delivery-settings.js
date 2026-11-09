$('routing-form').querySelector('button.primary').insertAdjacentHTML('beforebegin',`<fieldset id="amazon-delivery-settings">
 <legend>Amazon · départements et délais de livraison</legend>
 <label>Départements exclus de GOFO<textarea id="amazon-gofo-exclusions" rows="2" maxlength="600" placeholder="Codes séparés par des virgules, par exemple : 01, 2A, 971"></textarea></label>
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
 $('amazon-gofo-exclusions').value=(config.gofoExcludedDepartments||[]).join(', ');
 for(const carrier of ['gls','gofo'])$('amazon-origin-'+carrier).value=config.amazonDeliveryOrigins?.[carrier]||'';
 $('amazon-delivery-rows').replaceChildren();(config.amazonDeliveryRules||[]).forEach(addAmazonDeliveryRow);
}
function readAmazonDeliverySettings(){
 return {gofoExcludedDepartments:$('amazon-gofo-exclusions').value.split(/[\s,;]+/).filter(Boolean),amazonDeliveryOrigins:{gls:$('amazon-origin-gls').value.trim(),gofo:$('amazon-origin-gofo').value.trim()},amazonDeliveryRules:[...$('amazon-delivery-rows').children].map(tr=>({carrier:tr.querySelector('[name=carrier]').value,originPostal:tr.querySelector('[name=originPostal]').value.trim(),department:tr.querySelector('[name=department]').value.trim(),workDays:Number(tr.querySelector('[name=workDays]').value)}))};
}
$('amazon-delivery-add').onclick=()=>addAmazonDeliveryRow();
