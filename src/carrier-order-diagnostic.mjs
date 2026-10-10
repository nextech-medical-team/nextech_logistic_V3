import {trackingClient} from './carrier-tracking.mjs';
import {aggregateParcels} from './status-policy.mjs';
import {glsDiagnosticEvent} from './gls-diagnostic-events.mjs';

// Only SELECT and the dedicated tracking client's read method are available.
// No PDF retrieval, shipment creation or order/ERP lifecycle mutation occurs.
export function carrierDiagnosticReader(db,directory,{client=trackingClient(directory),now=()=>new Date()}={}){
 return {async read(orderId,provider){
  if(!['GLS','GOFO'].includes(provider))throw Error('Transporteur de suivi non pris en charge');
  const carrier=provider.toLowerCase();
  const main=(await db.query('SELECT carrier,environment,tracking,status,error FROM carrier_jobs WHERE order_id=$1',[orderId])).rows;
  const extras=(await db.query("SELECT carrier,environment,tracking,status,error FROM extra_parcels WHERE order_id=$1 AND status<>'cancelled'",[orderId])).rows;
  const partials=(await db.query("SELECT carrier,environment,tracking,status,error FROM partial_deliveries WHERE order_id=$1 AND status<>'cancelled'",[orderId])).rows;
  const parcels=[],errors=[],targets=new Map(),local=[];
  for(const [kind,rows] of [['principal',main],['supplémentaire',extras],['partiel',partials]])for(const row of rows){
   const normalized=row.carrier?.startsWith('gls')?'gls':row.carrier;if(normalized!==carrier)continue;
   local.push({kind,status:row.status,error:row.error||null});
   const numbers=Array.isArray(row.tracking)?row.tracking:typeof row.tracking==='string'?[row.tracking]:[];
   if(!numbers.length)errors.push({message:provider+' · Numéro de suivi absent pour le colis '+kind+'.'});
   if(row.environment!=='production'){errors.push({message:provider+' · Environnement absent ou non PROD : aucun appel de suivi effectué pour ce colis.'});continue;}
   for(const number of numbers){
    if(typeof number!=='string'||!/^[a-zA-Z0-9-]{4,80}$/.test(number)){errors.push({message:provider+' · Numéro de suivi invalide : vérifier le colis enregistré.'});continue;}
    targets.set(number,{carrier,environment:'production',tracking:number});
   }
  }
  if(!targets.size)errors.push({message:provider+' · Aucun numéro de suivi PROD utilisable. Vérifiez le résultat de création existant avant toute nouvelle étiquette.'});
  const cooldown=(await db.query('SELECT until_at FROM carrier_tracking_cooldown WHERE carrier=$1 AND environment=$2 AND until_at>now()',[carrier,'production'])).rows[0];
  let quota=null;
  for(const target of targets.values()){
   if(quota){errors.push({tracking:target.tracking,message:provider+' · Autres lectures différées après une limite API.'});continue;}
   if(cooldown){errors.push({tracking:target.tracking,message:provider+' · Limite API atteinte : prochain essai après '+new Date(cooldown.until_at).toISOString()});continue;}
   try{
    const events=await client.read(target.carrier,target.environment,target.tracking);
    if(!Array.isArray(events)||!events.length||events.some(e=>e.carrier!==carrier||e.tracking!==target.tracking||!Number.isFinite(Date.parse(e.at))))throw Error(provider+' · Réponse de suivi absente, incomplète ou associée à un autre colis');
    const status=aggregateParcels([target.tracking],events.map(glsDiagnosticEvent)).status;
    parcels.push({...target,status,events});
    if(status==='unknown')errors.push({tracking:target.tracking,message:provider+' · Événements reçus mais statut non déterminé : vérifier le suivi du colis.'});
   }catch(e){errors.push({tracking:target.tracking,message:String(e.message)});if(e.retryAfter>=7200)quota=e.retryAfter;}
  }
  const labels={delivered:'Livré',shipped:'En acheminement',not_shipped:'Non expédié',exception:'Incident',unknown:'Statut non déterminé',cancelled:'Annulé'};
  const descriptions=parcels.map(p=>p.tracking+' : '+(labels[p.status]||p.status));
  const localErrors=local.filter(x=>x.error).map(x=>'Création '+x.kind+' : '+x.error);
  return {readOnly:true,provider,checkedAt:now().toISOString(),parcels,errors,local,
   message:[descriptions.length?'Suivi '+provider+' interrogé par API. '+descriptions.join(' ; '):'Aucun suivi '+provider+' confirmé par API.',...errors.map(e=>e.message),...localErrors,'Aucune étiquette ni donnée Erplain modifiée.'].join(' ')};
 }};
}
