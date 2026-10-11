import {createHash} from 'node:crypto';
import {withShipmentLock} from './shipment-lock.mjs';
import {aggregateParcels} from './status-policy.mjs';

export const hasExternalLabel=o=>o?.channel==='temu'&&o.source_payload?.externalLabel?.active===true;
export function externalLabelInput(b){
 if(b.confirmed!==true)throw Error('Confirmez que les étiquettes externes couvrent tous les colis de cette commande');
 const carrier=String(b.carrier||'').trim();
 const tracking=String(b.tracking||'').split(/[\n,;]/).map(s=>s.trim()).filter(Boolean);
 if(!carrier||carrier.length>80||/[\x00-\x1f<>]/.test(carrier))throw Error('Transporteur invalide');
 if(!tracking.length||tracking.length>100||new Set(tracking).size!==tracking.length||tracking.some(s=>s.length>100||! /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(s)))throw Error('Numéros de suivi invalides ou dupliqués');
 let pdf=null;
 if(b.pdf){if(typeof b.pdf!=='string'||b.pdf.length>14*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(b.pdf))throw Error('PDF invalide');pdf=Buffer.from(b.pdf,'base64');if(pdf.length>10*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('PDF invalide (maximum 10 Mo)');}
 const fingerprint=createHash('sha256').update(JSON.stringify({carrier,tracking,pdf:pdf?createHash('sha256').update(pdf).digest('hex'):null})).digest('hex');
 return {carrier,tracking,pdf,fingerprint};
}
export function isTemuLabelIssue(issue){return /^TEMU\s*[·:]\s*(?:Étiquette refusée|Adresse\s*:.*caract|PDF|Achat TEMU|Étiquette TEMU)/i.test(String(issue||''))&&!/(?:stock insuffisant|Erplain|BL manquant|BC manquant|suspend|annulation)/i.test(String(issue||''));}
export async function registerExternalLabel(db,b,user){
 const input=externalLabelInput(b);
 const reference=(await db.query('SELECT reference FROM orders WHERE id=$1',[b.id])).rows[0]?.reference;
 if(!reference)throw Error('Commande absente');
 return withShipmentLock(()=>db.transaction(async tx=>{
  const o=(await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
  if(o.channel!=='temu'||o.archived||o.partial_mode)throw Error('Enregistrement réservé à une commande TEMU active complète');
  if(hasExternalLabel(o)){if(o.source_payload.externalLabel.fingerprint===input.fingerprint)return {reference,saved:true,alreadySaved:true};throw Error('Une étiquette externe est déjà enregistrée : les données existantes sont conservées');}
  const j=(await tx.query('SELECT * FROM temu_label_jobs WHERE reference=$1 FOR UPDATE',[reference])).rows[0];
  if(j?.status==='purchasing')throw Error('Achat en cours : attendre sa fin avant cet enregistrement');
  const busy=(await tx.query("SELECT 1 FROM carrier_jobs WHERE order_id=$1 AND status IN ('creating','awaiting_pdf','review') UNION ALL SELECT 1 FROM extra_parcels WHERE order_id=$1 AND status IN ('pending','creating','review')",[o.id])).rows.length;
  if(busy)throw Error('Création transporteur en cours : attendre sa fin avant cet enregistrement');
  const declaration={active:true,carrier:input.carrier,tracking:input.tracking,fingerprint:input.fingerprint,hasPdf:!!input.pdf,registeredAt:new Date().toISOString(),registeredBy:user.email};
  await tx.exec('CREATE TABLE IF NOT EXISTS temu_external_label_documents(order_id text PRIMARY KEY REFERENCES orders(id),pdf bytea NOT NULL)');
  if(input.pdf)await tx.query('INSERT INTO temu_external_label_documents(order_id,pdf) VALUES($1,$2)',[o.id,input.pdf]);
  await tx.query("UPDATE orders SET source_payload=source_payload||$2::jsonb,transport_choice=null,carrier='temu',label_status=CASE WHEN $3 AND label_status<>'cancelled' AND tracking_status<>'cancelled' THEN 'ready' ELSE label_status END,issue=CASE WHEN $4 THEN null ELSE issue END WHERE id=$1",[o.id,JSON.stringify({externalLabel:declaration}),!o.issue||isTemuLabelIssue(o.issue),isTemuLabelIssue(o.issue)]);
  await tx.query("INSERT INTO temu_label_jobs(reference,status,result) VALUES($1,'external',$2) ON CONFLICT(reference) DO UPDATE SET status='external',error=null,plan=null,result=coalesce(temu_label_jobs.result,'{}'::jsonb)||excluded.result,updated_at=now()",[reference,JSON.stringify({externalLabelResolution:{at:declaration.registeredAt,previousStatus:j?.status,previousError:j?.error,carrier:input.carrier}})]);
  await tx.query("UPDATE carrier_jobs SET status='superseded',updated_at=now() WHERE order_id=$1 AND status='pending'",[o.id]);
  await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'temu.external_label.registered',$2)",[user.email,JSON.stringify({orderId:o.id,...declaration,previousTemuStatus:j?.status,previousTemuError:j?.error,externalWrites:0})]);
  return {reference,saved:true,trackingSource:'temu',message:'Étiquette externe enregistrée. Refus d’étiquette TEMU classé dans l’historique ; suivi via TEMU.'};
 }),['temu-order:'+reference]);
}
export async function readExternalTemuTracking(db,o,api,shipments){
 const events=[],errors=[],packages=[...new Set((shipments.shipmentInfoDTO||[]).flatMap(p=>[p,...(p.subPackageShipmentInfoList||[])]).map(p=>p.packageSn).filter(Boolean))];
 for(const packageSn of packages){try{const t=await api.read('temu.track.trackinginfo.get',{packageSn});if(!o.source_payload.externalLabel.tracking.includes(String(t.trackingNum||'').trim()))continue;for(const e of t.trackingInfo||[]){const raw=e.logisticsUpdatedAt,at=/^\d{10,13}$/.test(raw||'')?new Date(Number(raw)*(String(raw).length===10?1000:1)).toISOString():raw;if(Number.isFinite(Date.parse(at)))events.push({source:'temu_tracking',trackingKey:t.trackingNum,code:e.logisticsStatus,label:e.statusText,at});}}catch(e){errors.push({package:packageSn,error:String(e.message).slice(0,300)});}}
 await db.query("UPDATE temu_label_jobs SET result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE reference=$1",[o.reference,JSON.stringify({deliveryStatuses:events,trackingErrors:errors,trackingObservedAt:new Date().toISOString()})]);
 const next=aggregateParcels(o.source_payload.externalLabel.tracking,events.map(e=>({...e,tracking:e.trackingKey,carrier:'temu'}))).status;
 if(['shipped','in_transit','delivered'].includes(next)&&o.tracking_status!=='delivered'&&!(o.tracking_status==='in_transit'&&next==='shipped'))await db.query("UPDATE orders SET tracking_status=$2 WHERE id=$1 AND tracking_status<>'cancelled'",[o.id,next]);
 return {reference:o.reference,status:'external',trackingSource:'temu',error:null};
}
