import {suspensionBlock} from './order-suspension.mjs';
import {hasExternalLabel} from './temu-external-label.mjs';
import {assertLabelStockGate} from './label-stock-gate.mjs';
import {automaticTemuMarginDecision} from './temu-purchase-policy.mjs';

export async function initializeTemuAutomaticPurchase(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS temu_automatic_purchase_checks(
 reference text PRIMARY KEY,checked_at timestamptz,next_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL DEFAULT '{}');
 CREATE OR REPLACE FUNCTION v3_wake_temu_automatic_purchase() RETURNS trigger AS $$
 DECLARE oid text; BEGIN
 IF TG_TABLE_NAME='orders' THEN oid=NEW.id; ELSE oid=NEW.order_id; END IF;
 INSERT INTO temu_automatic_purchase_checks(reference)
 SELECT reference FROM orders WHERE id=oid AND channel='temu' AND NOT archived
 ON CONFLICT(reference) DO UPDATE SET next_at=now();
 RETURN NEW; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS v3_wake_temu_purchase_order ON orders;
 CREATE TRIGGER v3_wake_temu_purchase_order AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION v3_wake_temu_automatic_purchase();
 DROP TRIGGER IF EXISTS v3_wake_temu_purchase_lines ON lines;
 CREATE TRIGGER v3_wake_temu_purchase_lines AFTER INSERT OR UPDATE ON lines FOR EACH ROW EXECUTE FUNCTION v3_wake_temu_automatic_purchase();
 DROP TRIGGER IF EXISTS v3_wake_temu_purchase_corrections ON correction_jobs;
 CREATE TRIGGER v3_wake_temu_purchase_corrections AFTER INSERT OR UPDATE ON correction_jobs FOR EACH ROW EXECUTE FUNCTION v3_wake_temu_automatic_purchase();`);
}
export function automaticPreparationHold(o,now=Date.now()){
 const blocked=suspensionBlock(o);if(blocked)return blocked;
 if(!o||o.archived||o.simulation||o.channel!=='temu')return 'Commande hors périmètre des achats automatiques';
 if(hasExternalLabel(o)||o.transport_choice)return 'Étiquette ou choix de transport existant à préserver';
 if(o.issue||o.source_payload?.visibilityHold||o.source_payload?.marketplacePendingCorrection||o.resolution_pending_resume||o.partial_mode)return o.issue||'Préparation à recontrôler avant achat';
 const p=o.erp_live;
 if(p?.phase!=='bl_ready'||p.pricing?.status!=='verified'||!p.bl?.id||!p.stockDocument)return 'Préparation Erplain non terminée';
 for(const value of [p.verifiedAt,p.stockCheckedAt]){const at=Date.parse(value);if(!Number.isFinite(at)||at>now||now-at>86400000)return 'Validation de préparation et stock à actualiser';}
 if(o.source_payload?.temuDirect?.state!=='verified')return 'Commande TEMU à vérifier';
 return null;
}
export function temuAutomaticPurchaseWorker(db,local,margins,{enabled=()=>true,stockGate=assertLabelStockGate}={}){
 let running=false;
 async function admission(reference,plan){
  if(!enabled())throw Error('Achat automatique suspendu');
  const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];
  const held=automaticPreparationHold(o);if(held)throw Error(held);
  const idle=(await db.query(`SELECT o.id FROM orders o WHERE o.id=$1
   AND EXISTS(SELECT 1 FROM erp_live_jobs e WHERE e.order_id=o.id AND e.status='complete')
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM temu_label_documents t WHERE t.reference=o.reference)
   AND NOT EXISTS(SELECT 1 FROM correction_jobs c WHERE c.order_id=o.id AND c.status IN ('queued','applying','checking','waiting','review'))
   AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=o.id AND r.status IN ('queued','running','waiting','review'))`,[o.id])).rows;
  if(!idle.length)throw Error('Correction, reprise ou étiquette existante à rapprocher avant achat');
  const lineProof=(await db.query("SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY source_line,id),'[]'::jsonb) lines FROM lines l WHERE order_id=$1",[o.id])).rows[0]?.lines||[];
  await stockGate(db,o);
  if(plan){
   const decision=automaticTemuMarginDecision(await margins.get({fresh:true}),reference,plan);
   if(!decision.allowed)throw Error(decision.message+' : '+decision.reason);
   return {...decision,orderProof:{id:o.id,erpLive:o.erp_live,sourcePayload:o.source_payload,address:o.address,suspension:o.suspension,weight:o.weight_kg,lines:lineProof}};
  }
 }
 return {get running(){return running;},async run(){
  if(running||!enabled())return;running=true;
  try{
   await db.query(`INSERT INTO temu_automatic_purchase_checks(reference)
    SELECT o.reference FROM orders o JOIN temu_label_jobs j ON j.reference=o.reference
    WHERE o.channel='temu' AND NOT o.archived AND j.status IN ('ready','to_buy')
    AND j.attempt_id IS NULL AND jsonb_array_length(j.packages)=0
    ON CONFLICT DO NOTHING`);
   const candidate=(await db.query(`SELECT c.reference FROM temu_automatic_purchase_checks c
    JOIN orders o ON o.reference=c.reference JOIN temu_label_jobs j ON j.reference=c.reference
    WHERE NOT o.archived AND c.next_at<=now() AND j.status IN ('ready','to_buy')
    AND j.attempt_id IS NULL AND jsonb_array_length(j.packages)=0
    ORDER BY c.next_at,c.reference LIMIT 1`)).rows[0];
   if(!candidate)return;
   const reference=candidate.reference;let result;
   try{
    await admission(reference);
    const amounts=await local.amounts(reference,{force:true});if(amounts.error)throw Error('Achat d’étiquette TEMU à confirmer : '+amounts.error);
    const plan=await local.prepare(reference);
    await admission(reference,plan);
    const purchased=await local.buy(reference,plan.id,plan.amount,{beforeClaim:current=>admission(reference,current)});
    result={status:purchased.status,message:purchased.status==='complete'?'Étiquette TEMU disponible':purchased.error||'Résultat TEMU en cours de vérification',at:new Date().toISOString()};
   }catch(e){result={status:'held',message:String(e.message).slice(0,600),at:new Date().toISOString()};}
   await db.query(`UPDATE temu_automatic_purchase_checks SET checked_at=now(),next_at=now()+interval '15 minutes',result=$2::jsonb WHERE reference=$1`,[reference,JSON.stringify(result)]);
  }finally{running=false;}
 }};
}
