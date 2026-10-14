import {retiredCommercialControl} from './post-bc-control-recovery.mjs';
import {suspensionBlock} from './order-suspension.mjs';
import {hasExternalLabel} from './temu-external-label.mjs';

export async function initializeTemuAutomaticPurchase(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS temu_automatic_purchase_checks(
 reference text PRIMARY KEY,checked_at timestamptz,next_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS temu_automatic_purchase_audit(attempt_id text PRIMARY KEY,reference text NOT NULL,plan_id text NOT NULL,decision jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
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
 CREATE TRIGGER v3_wake_temu_purchase_corrections AFTER INSERT OR UPDATE ON correction_jobs FOR EACH ROW EXECUTE FUNCTION v3_wake_temu_automatic_purchase();
 CREATE OR REPLACE FUNCTION v3_temu_purchase_result_diagnostic() RETURNS trigger AS $$
 BEGIN
 IF to_regclass('order_recheck_monitor') IS NOT NULL THEN
 UPDATE order_recheck_monitor m SET next_check=now(),requested=requested+1
 FROM orders o WHERE o.id=m.order_id AND o.reference=NEW.reference;
 END IF;
 RETURN NEW; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS v3_temu_purchase_result ON temu_automatic_purchase_checks;
 CREATE TRIGGER v3_temu_purchase_result AFTER UPDATE OF result ON temu_automatic_purchase_checks FOR EACH ROW EXECUTE FUNCTION v3_temu_purchase_result_diagnostic();`);
}
export function automaticPreparationHold(o,now=Date.now()){
 if(o?.source_payload?.origin==='temu_excel'&&!o.source_payload.temuExcelPreparation)return 'Excel TEMU : préparation à terminer';
 const blocked=suspensionBlock(o);if(blocked)return blocked;
 if(!o||o.archived||o.simulation||o.channel!=='temu')return 'Commande hors périmètre des achats automatiques';
 if(hasExternalLabel(o)||o.transport_choice)return 'Étiquette ou choix de transport existant à préserver';
 if((o.issue&&!(o.erp_live?.bc?.id&&retiredCommercialControl(o.issue)))||o.source_payload?.visibilityHold||(!o.erp_live?.bc?.id&&o.source_payload?.marketplacePendingCorrection)||o.resolution_pending_resume||o.partial_mode)return o.issue||'Préparation à recontrôler avant achat';
 const p=o.erp_live;
 if(p?.phase!=='bl_ready'||(!o.erp_live?.bc?.id&&p.pricing?.status!=='verified')||!p.bl?.id||!p.stockDocument)return 'Préparation Erplain non terminée';
 for(const value of [p.verifiedAt,p.stockCheckedAt]){const at=Date.parse(value);if(!Number.isFinite(at)||at>now)return 'Validation de préparation et stock à actualiser';}
 if(o.source_payload?.temuDirect?.state!=='verified')return 'Commande TEMU à vérifier';
 return null;
}
// Compatibility entry point for older callers. Purchases now require the
// authenticated /api/temu/buy route and its explicit price confirmation.
export function temuAutomaticPurchaseWorker(){
 return {running:false,async run(){return {status:'disabled',message:'Achat manuel : confirmation du prix requise'};}};
}
