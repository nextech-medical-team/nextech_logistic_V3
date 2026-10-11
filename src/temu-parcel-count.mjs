// Human rule, 11 October 2026: new TEMU parcels always use one package.
// Existing documents/tracking and legacy positive counts are never rewritten.
export const TEMU_PARCEL_VERSION='temu-single-parcel-20261011-1';
export const TEMU_PARCEL_TRIGGER_SQL=`
CREATE OR REPLACE FUNCTION nextech_temu_single_parcel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.channel='temu' THEN NEW.parcel_count:=1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER nextech_temu_single_parcel BEFORE INSERT OR UPDATE OF channel,parcel_count ON orders
FOR EACH ROW EXECUTE FUNCTION nextech_temu_single_parcel();`;
export async function installTemuParcelRule(db){
 await db.withLocks(['schema'],()=>db.transaction(async tx=>{
  if((await tx.query('SELECT version FROM schema_migrations WHERE version=$1',[TEMU_PARCEL_VERSION])).rows.length)return;
  await tx.exec(TEMU_PARCEL_TRIGGER_SQL);
  await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[TEMU_PARCEL_VERSION]);
 }));
}
export const legacyParcelReason='Poids ou nombre de colis absent';
export const correctedParcelReason='Nombre de colis corrigé · préparation à vérifier';
export async function reconcileTemuParcelDiagnostics(db,orderId){
 const candidate=(await db.query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
 if(candidate?.channel!=='temu')return;
 await db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
  if(o?.channel!=='temu'||!(Number(o.weight_kg)>0)||Number(o.parcel_count)!==1)return;
  await tx.query("UPDATE resolution_jobs SET error=$3,stage='Nombre de colis corrigé · suite à vérifier',updated_at=now() WHERE order_id=$1 AND status='review' AND error=$2",[o.id,legacyParcelReason,correctedParcelReason]);
  await tx.query('UPDATE orders SET issue=null WHERE id=$1 AND issue=$2',[o.id,legacyParcelReason]);
  await tx.query('UPDATE erp_live_jobs SET error=null WHERE order_id=$1 AND error=$2',[o.id,legacyParcelReason]);
 });
}
