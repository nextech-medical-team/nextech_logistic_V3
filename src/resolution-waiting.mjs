import {advanceEquivalentLabel} from './equivalent-auto-label.mjs';
import {regenerateProductionLabels} from './label-regeneration.mjs';

// Only local status reconciliation and native queueing; no remote API calls.

export function waitingResolutionWorker(db,{regenerate=regenerateProductionLabels}={}){

 let running=false;

 const update=async(id,status,stage,result=null,error=null)=>db.query("UPDATE resolution_jobs SET status=$2,stage=$3,result=coalesce($4::jsonb,result),error=$5,updated_at=now() WHERE id=$1 AND status='waiting'",[id,status,stage,result?JSON.stringify(result):null,error]);

 async function advance(j){

     await db.query('UPDATE resolution_jobs SET updated_at=now() WHERE id=$1',[j.id]);

     const o=(await db.query('SELECT * FROM orders WHERE id=$1',[j.order_id])).rows[0],erp=(await db.query('SELECT * FROM erp_live_jobs WHERE order_id=$1',[j.order_id])).rows[0];

     if(!o||o.archived)throw Error('Commande archivée : aucune reprise automatique');

     if(j.result?.pdfOnly){const c=(await db.query('SELECT status,error FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];if(c?.status==='ready')await update(j.id,'complete','Terminé',{message:j.result.stockOverride?'Étiquette PROD créée par dérogation. Stock insuffisant : aucun BL ni mouvement de stock créé.':'PDF existant récupéré dans V3, sans nouvelle expédition.'});else if(['failed','review'].includes(c?.status))throw Error(c.error||'PDF non reçu');return;}

     if(erp?.status==='review'){await update(j.id,'review','Erplain à compléter',j.result,erp.error);return;}

     const automatic=await advanceEquivalentLabel(db,j);
     if(automatic.handled)return;

     // Other document-only corrections retain their separate label decision.

     // Check the action as well as result flags for jobs created by earlier versions.

     const preparationOnly=['resume-erp','refresh','resume','mapping','weight','create-product','activate-product','select-product','address','relay','manual-temu-pricing'].includes(j.action)||j.result?.equivalent||j.result?.erpOnly;

     if(preparationOnly){

      if(erp?.status!=='complete')return;

      if(!o.erp_live?.bl?.id||o.erp_live.bl.status!=='ready_to_ship'||!o.erp_live?.verifiedAt||!o.erp_live?.stockCheckedAt)throw Error('Validation stock/BL absente : contrôler les documents Erplain avant étiquette.');

      await db.query("UPDATE orders SET resolution_pending_resume=true WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status='ready')",[o.id]);

      const message=j.result?.manualPricing?'Prix enregistrés et BL Erplain LIVE vérifié. L’achat de l’étiquette reste manuel.':(j.action==='replace-equivalent'||j.result?.equivalent)?'Remplacement enregistré et BL Erplain LIVE vérifié. Les étiquettes existantes sont conservées à l’identique. Tout nouvel achat reste manuel.':'BL Erplain LIVE vérifié. Les étiquettes existantes sont conservées à l’identique. Tout nouvel achat reste manuel.';

      await update(j.id,'complete','Terminé',{...j.result,erpOnly:true,message});return;

     }

     if(erp?.status!=='complete')return;

     if(!o.erp_live?.bl?.id||!o.erp_live?.verifiedAt||!o.erp_live?.stockCheckedAt)throw Error('Validation stock/BL absente : contrôler les documents Erplain avant étiquette.');

     if(j.result?.regenerateExisting&&!j.result?.labelRequested){const r=await regenerate(db,{ids:[o.id],batchId:'resolution-'+j.id,allowReady:true});if(r.skipped.length)throw Error(r.skipped[0].reason);await update(j.id,'waiting','Nouvelle étiquette GLS/GOFO · réimpression nécessaire',{...j.result,labelRequested:true});return;}

     if(!j.result?.labelRequested){const existing=(await db.query('SELECT status,result,tracking FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];if(existing&&(['ready','pending','creating','awaiting_pdf'].includes(existing.status)||existing.result||existing.tracking?.length)){if(['failed','review'].includes(existing.status))throw Error('Création transport à vérifier : aucune recréation automatique');if(existing.status==='ready'&&erp?.status==='complete'){await update(j.id,'complete','Terminé',{message:'Étiquette existante conservée et documents Erplain LIVE vérifiés.'});return;}await update(j.id,'waiting','Suivi de l’étiquette existante',{...j.result,labelRequested:true});return;}const r=await regenerate(db,{ids:[o.id],batchId:'resolution-'+j.id});if(r.skipped.length)throw Error(r.skipped[0].reason);await update(j.id,'waiting','Génération de l’étiquette GLS/GOFO PROD',{...j.result,labelRequested:true});return;}

     const c=(await db.query('SELECT status,error FROM carrier_jobs WHERE order_id=$1',[o.id])).rows[0];if(['failed','review'].includes(c?.status))throw Error(c.error||'Transporteur à vérifier');

     if(c?.status==='ready'&&erp?.status==='complete')await update(j.id,'complete','Terminé',{message:j.result?.regenerateExisting?'Nouvelle étiquette disponible. Réimprimez-la et remplacez l’ancienne sur le colis. Documents Erplain LIVE vérifiés.':'Étiquette disponible dans V3 et documents Erplain LIVE vérifiés.'});return;



 }

 return {async run(){

  if(running)return;running=true;

  try{

   const jobs=(await db.query("SELECT * FROM resolution_jobs WHERE status='waiting' ORDER BY updated_at,order_id LIMIT 25")).rows;

   for(const j of jobs){try{await advance(j);}catch(e){await update(j.id,'review','À vérifier',null,e.message);}}

  }finally{running=false;}

 }};

}

