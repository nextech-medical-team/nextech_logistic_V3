import {randomUUID} from 'node:crypto';
import {withShipmentLock} from './shipment-lock.mjs';
export function testRetirementReason(o,hasProductionHistory){
 if(o.archived||o.reference.startsWith('DEMO-'))return 'Commande archivée ou fictive';
 if(o.channel==='temu')return 'Circuit achat TEMU indépendant';
 if(o.partial_mode)return 'Livraison partielle à contrôler';
 if(['shipped','in_transit','delivered','delivered_simulated','cancelled'].includes(o.tracking_status))return 'Commande expédiée ou annulée';
 if(['cancelled','closed','completed'].includes(o.erp_live?.bc?.status)||o.source_payload?.cancelled||o.source_payload?.cancelled_at)return 'Commande clôturée ou annulée';
 if(o.source_payload?.marketplacePendingCorrection)return 'Modification plateforme à valider';
 if(hasProductionHistory||o.source_payload?.historicalShipments?.length)return 'Expédition réelle existante à contrôler';
 if(!['gls','gls_shop','gls_pharma','gofo'].includes(o.carrier))return 'Transporteur à déterminer';
 return null;
}
// Archive the sandbox artifacts atomically, then use the normal checked resume.
export async function retireTestCarrierJobs(db){return withShipmentLock(()=>db.transaction(async tx=>{
 const rows=(await tx.query(`SELECT o.*,to_jsonb(c) test_job,
 EXISTS(SELECT 1 FROM carrier_label_history h WHERE h.order_id=o.id AND h.job->>'environment'='production') has_production_history
 FROM orders o JOIN carrier_jobs c ON c.order_id=o.id
 WHERE c.environment='test' AND c.status IN ('ready','failed','review','superseded')
 AND (coalesce(c.reference,'')='' OR c.reference LIKE 'V3T%')
 AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting'))
 AND NOT EXISTS(SELECT 1 FROM correction_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','applying','checking','waiting'))
 AND NOT EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status IN ('pending','processing'))
 ORDER BY o.processing_priority_at ASC NULLS LAST,o.id LIMIT 100 FOR UPDATE OF o,c SKIP LOCKED`)).rows;
 for(const o of rows){const archiveId=randomUUID(),reason=testRetirementReason(o,o.has_production_history);
 await tx.query('INSERT INTO carrier_label_history(id,order_id,job) VALUES($1,$2,$3)',[archiveId,o.id,JSON.stringify({...o.test_job,retirement:'test-to-production-v1'})]);
 await tx.query('INSERT INTO carrier_label_history_documents SELECT $1,document_index,pdf FROM carrier_documents WHERE order_id=$2',[archiveId,o.id]);
 await tx.query('DELETE FROM carrier_documents WHERE order_id=$1',[o.id]);
 await tx.query("DELETE FROM carrier_jobs WHERE order_id=$1 AND environment='test'",[o.id]);
 await tx.query("UPDATE orders SET label_status=CASE WHEN label_status='sandbox_ready' THEN 'pending' ELSE label_status END,issue=CASE WHEN issue=$2 THEN null ELSE issue END WHERE id=$1",[o.id,o.test_job.error]);
 if(!reason){const id=randomUUID(),requestId='test-to-production-'+archiveId;
 await tx.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[o.id]);
 await tx.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,status,stage,payload) VALUES($1,$2,$3,'resume','queued','Préparation PROD après archivage TEST',$4)",[id,o.id,requestId,JSON.stringify({id:o.id,requestId,action:'resume',type:'resolved'})]);
 }
 await tx.query("INSERT INTO audit(user_email,action,detail) VALUES('system','labels.test_retired',$1)",[JSON.stringify({orderId:o.id,archiveId,productionResumeQueued:!reason,reason})]);
 }
 return rows.length;
}));}
