import {temuLabelPurchaseHold} from './temu-label-order-policy.mjs';
import {createdBlSql} from './created-bl-label.mjs';
import {automaticTemuMarginDecision} from './temu-purchase-policy.mjs';

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
export const automaticPreparationHold=temuLabelPurchaseHold;
// Untouched TEMU orders enter automatic purchase only after BL creation.
const discoverableJobSql=`(j.status IN ('ready','to_buy','api_error','unverified') OR j.reference IS NULL)
 AND j.attempt_id IS NULL AND coalesce(jsonb_array_length(j.packages),0)=0`;
export function temuAutomaticPurchaseWorker(db,local,margins,{enabled=()=>true}={}){
 let running=false;
 async function admission(reference,plan){
  if(!enabled())throw Error('Achat automatique suspendu');
  const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];
  const held=temuLabelPurchaseHold(o);if(held)throw Error(held);
  const idle=(await db.query(`SELECT o.id FROM orders o WHERE o.id=$1
   AND NOT EXISTS(SELECT 1 FROM carrier_jobs c WHERE c.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM carrier_documents d WHERE d.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM extra_parcels x WHERE x.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM temu_label_documents t WHERE t.reference=o.reference)`,[o.id])).rows;
  if(!idle.length)throw Error('Étiquette ou transport existant à rapprocher avant achat');
  if(!plan)return o;
  const lines=(await db.query("SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY source_line,id),'[]'::jsonb) lines FROM lines l WHERE order_id=$1",[o.id])).rows[0]?.lines||[];
  const decision=automaticTemuMarginDecision(await margins.get({fresh:true}),reference,plan);
  if(!decision.allowed)throw Error(decision.message+' : '+decision.reason);
  return {...decision,orderProof:{id:o.id,sourcePayload:o.source_payload,address:o.address,suspension:o.suspension,weight:o.weight_kg,lines}};
 }
 async function execute(reference){
  await admission(reference);
  const recovered=await local.recover(reference);
  if(recovered&&(recovered.documents||['complete','external','pending','shipment_error','document_unavailable','uncertain'].includes(recovered.status)))return {status:recovered.status,message:recovered.error||'Étiquette existante récupérée ; aucun nouvel achat'};
  if(recovered?.deferred||recovered?.error)throw Error(recovered.error||recovered.message||'Lecture TEMU en attente');
  const amounts=await local.amounts(reference,{force:true});if(amounts.error)throw Error(amounts.error);
  const plan=recovered?.plan||await local.prepare(reference);
  await admission(reference,plan);
  const purchased=await local.buy(reference,plan.id,plan.amount,{beforeClaim:current=>admission(reference,current)});
  return {status:purchased.status,message:purchased.error||'Étiquette TEMU disponible',packages:purchased.packages};
 }
 return {get running(){return running;},async process(reference){
  // A targeted authorized recovery uses the exact same policy as the worker.
  if(running||!enabled())throw Error('Achat automatique occupé ou suspendu');running=true;
  try{return await execute(reference);}finally{running=false;}
 },async run(){
  if(running||!enabled())return;running=true;
  try{
   await db.query(`INSERT INTO temu_automatic_purchase_checks(reference)
    SELECT o.reference FROM orders o LEFT JOIN temu_label_jobs j ON j.reference=o.reference
    WHERE o.channel='temu' AND NOT o.archived AND ${createdBlSql} AND ${discoverableJobSql}
    ON CONFLICT DO NOTHING`);
   const candidate=(await db.query(`SELECT c.reference FROM temu_automatic_purchase_checks c
    JOIN orders o ON o.reference=c.reference LEFT JOIN temu_label_jobs j ON j.reference=c.reference
    WHERE o.channel='temu' AND NOT o.archived AND ${createdBlSql} AND c.next_at<=now() AND ${discoverableJobSql}
    ORDER BY c.next_at,c.reference LIMIT 1`)).rows[0];
   if(!candidate)return;
   const reference=candidate.reference;let result;
   try{result=await execute(reference);}catch(e){result={status:'held',message:String(e.message).slice(0,600)};}
   result.at=new Date().toISOString();
   await db.query(`UPDATE temu_automatic_purchase_checks SET checked_at=now(),next_at=now()+interval '15 minutes',result=$2::jsonb WHERE reference=$1`,[reference,JSON.stringify(result)]);
  }finally{running=false;}
 }};
}
