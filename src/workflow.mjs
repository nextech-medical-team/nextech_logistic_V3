import {configuredShopifyMode} from './shopify-delivery.mjs';
import {currentMappingLine} from './current-mapping-line.mjs';
import {loadRouting,chosenRoute} from './routing.mjs';

import {randomUUID} from 'node:crypto';

import {addressIssue,convertedQuantity,route} from './domain.mjs';



export function simulatedPdf(reference,tracking){

  const escape=s=>String(s).replace(/[^\x20-\x7e]/g,'?').replace(/[()\\]/g,'\\$&');

  const lines=['NEXTECH LOGISTIC V3','SIMULATION - NON VALABLE POUR LE TRANSPORT',`Commande : ${reference}`,`Reference fictive : ${tracking}`,'Aucun transporteur appele. Aucune etiquette achetee.'];

  const stream='BT /F1 14 Tf 35 350 Td '+lines.map((s,i)=>(i?'0 -35 Td ':'')+`(${escape(s)}) Tj`).join('\n')+' ET';

  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 420] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];

  let out='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;}

  const start=Buffer.byteLength(out);out+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;

  return Buffer.from(out);

}

export async function prepareLabel(db,o){
  if(o.channel==='temu'&&o.source_payload?.externalLabel?.active)return;

  const issue=addressIssue(o.address);if(issue)throw new Error(issue);

  const {rows}=await db.query(`SELECT l.*,m.target_sku AS mapped_sku,m.source_qty,m.target_qty,coalesce((l.source_payload->>'erplainCorrectedWeightKg')::numeric,p.weight_kg) AS weight_kg,p.origin,CASE WHEN l.source_payload->>'erplainSourceVariantId' IS NOT NULL AND l.source_payload->>'erplainCorrectedWeightKg' IS NOT NULL THEN null ELSE c.message END AS message FROM lines l LEFT JOIN mappings m ON m.channel=$2 AND m.source_sku=l.source_sku LEFT JOIN products p ON p.sku=CASE WHEN $3 OR l.source_payload->>'mappingScope'='order' THEN l.target_sku ELSE coalesce(m.target_sku,l.target_sku,CASE WHEN $2 IN ('tender','samples') THEN l.source_sku END) END LEFT JOIN catalog_results c ON c.sku=p.sku WHERE l.order_id=$1`,[o.id,o.channel,o.channel!=='tender'&&!!o.erp_live?.bc?.id]);

  let weight=0;const missing=[],invalid=[],unmapped=[];

  for(const l of rows){

    const {sku,quantity:qty}=currentMappingLine(l,o.channel,{recordedBc:o.channel!=='tender'&&!!o.erp_live?.bc?.id});


    if(sku&&(o.channel==='tender'||!o.erp_live?.bc?.id))await db.query('UPDATE lines SET target_sku=$2,target_quantity=$3 WHERE id=$1',[l.id,sku,qty]);

    if(!sku)unmapped.push(l.source_sku);

    else if(l.message)invalid.push(sku+' : '+l.message);

    else if(!l.weight_kg)missing.push(sku);

    else weight+=Number(qty)*Number(l.weight_kg);

  }

  if(o.channel!=='temu'||o.transport_choice){

    if(unmapped.length)throw new Error('Correspondance SKU absente : '+unmapped.join(', '));

    if(invalid.length)throw new Error(invalid.join(' ; '));

    if(missing.length){const e=new Error('En attente de synchronisation Erplain : '+missing.join(', '));e.waitingCatalog=true;throw e;}

  }

  const routing=await loadRouting(db);if(o.channel==='shopify'&&!o.transport_choice){const mode=configuredShopifyMode(o.source_payload,routing);if(mode==='unknown')throw Error('Shopify · Règle transport manquante : '+(o.source_payload?.shipping_lines||[]).map(l=>l.title||l.code).filter(Boolean).join(', '));o.source_payload={...o.source_payload,shopifyDeliveryMode:mode};await db.query('UPDATE orders SET source_payload=$2 WHERE id=$1',[o.id,JSON.stringify(o.source_payload)]);}
  // Never round a positive sub-gram weight down to zero before routing.
  const r=chosenRoute(o,Math.ceil(weight*1000)/1000,routing);

  const tracking='SIM-'+o.id.slice(0,8).toUpperCase();

  await db.query('INSERT INTO labels(order_id,tracking,pdf) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING',[o.id,tracking,simulatedPdf(o.reference,tracking)]);

  await db.query(`UPDATE orders SET label_status='simulated',simulation=true,weight_kg=$2,parcel_count=$3,carrier=$4,issue=null WHERE id=$1`,[o.id,r.weight,r.parcels,r.carrier]);

}

export async function runJobs(db,limit=25,{carriersEnabled=false}={}){

  let handled=0;

  for(let i=0;i<limit;i++){

    const claimed=await db.transaction(async tx=>{

      const {rows}=await tx.query(`SELECT * FROM jobs WHERE NOT EXISTS(SELECT 1 FROM orders suspended_order WHERE suspended_order.id=jobs.order_id AND (coalesce(suspended_order.suspension->>'active','false')='true' OR suspended_order.suspension ? 'erplainCancellation')) AND ((status='pending' AND available_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')) AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=jobs.order_id AND o.resolution_pending_resume=true) AND NOT EXISTS(SELECT 1 FROM resolution_jobs r WHERE r.order_id=jobs.order_id AND r.status IN ('queued','running')) ORDER BY CASE WHEN kind='label' THEN 0 ELSE 1 END,available_at FOR UPDATE SKIP LOCKED LIMIT 1`);

      if(!rows.length)return null;

      await tx.query(`UPDATE jobs SET status='processing',locked_at=now(),attempts=attempts+1 WHERE id=$1`,[rows[0].id]);return rows[0];

    });

    if(!claimed)break;

    try{

      await db.transaction(async tx=>{

        const {rows}=await tx.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[claimed.order_id]);const o=rows[0];

        if(o&&!o.partial_mode){

          if(claimed.kind==='label'){

            await prepareLabel(tx,o);

            // Production admission follows in reconcileAutomaticTest, after BL proof.
            // Do not create a transport job from a local simulation or BC alone.

          }

          else if(claimed.kind==='erp')await tx.query(`UPDATE orders SET erp_status='simulated_only' WHERE id=$1`,[o.id]);

          else if(claimed.kind==='invoice'&&o.tracking_status==='delivered_simulated')await tx.query(`UPDATE orders SET invoice_status='simulated_only' WHERE id=$1`,[o.id]);

        }

        await tx.query(`UPDATE jobs SET status='complete',error=null WHERE id=$1`,[claimed.id]);

      });

    }catch(e){

      await db.transaction(async tx=>{

        await tx.query(`UPDATE jobs SET status='blocked',error=$2 WHERE id=$1`,[claimed.id,e.message]);

        if(claimed.kind==='label')await tx.query(`UPDATE orders SET label_status=$3,issue=$2 WHERE id=$1`,[claimed.order_id,e.message,e.waitingCatalog?'waiting_catalog':'blocked']);

      });

    }

    handled++;

  }

  return handled;

}

export async function refreshTracking(db,ids,delivered=false){

  if(!ids.length||ids.length>100)throw new Error('Sélectionner entre 1 et 100 commandes');

  return db.transaction(async tx=>{

    const {rows}=await tx.query('SELECT id,label_status FROM orders WHERE id=ANY($1::text[]) FOR UPDATE',[ids]);let updated=0;

    for(const o of rows){

      if(o.label_status!=='simulated')continue;

      if(delivered){

        await tx.query(`UPDATE orders SET tracking_status='delivered_simulated' WHERE id=$1`,[o.id]);

        await tx.query(`INSERT INTO jobs(id,order_id,kind) VALUES($1,$2,'invoice') ON CONFLICT(order_id,kind) DO NOTHING`,[randomUUID(),o.id]);

      }

      updated++;

    }

    return {updated,mode:'simulation',message:delivered?`${updated} livraisons simulées. Facturation Erplain simulée uniquement.`:`${updated} commandes vérifiées localement. Aucun suivi transporteur réel connecté.`};

  });

}

export async function createDemo(db){

  const id=randomUUID(),sku='DEMO-V3-200G';

  await db.transaction(async tx=>{

    await tx.query(`INSERT INTO products(sku,weight_kg,origin) VALUES($1,0.2,'fixture') ON CONFLICT DO NOTHING`,[sku]);

    await tx.query(`INSERT INTO mappings(channel,source_sku,target_sku,source_qty,target_qty) VALUES('amazon',$1,$1,1,1) ON CONFLICT DO NOTHING`,[sku]);

    await tx.query(`INSERT INTO orders(id,channel,reference,recipient,address,simulation) VALUES($1,'amazon',$2,'Destinataire fictif',$3,true)`,[id,'DEMO-'+id.slice(0,8),JSON.stringify({name:'Destinataire fictif',street:'1 rue de Test',postal:'75001',city:'Paris',country:'FR'})]);

    await tx.query(`INSERT INTO lines(id,order_id,source_line,source_sku,quantity) VALUES($1,$2,'1',$3,2)`,[randomUUID(),id,sku]);

    for(const kind of ['label','erp'])await tx.query(`INSERT INTO jobs(id,order_id,kind) VALUES($1,$2,$3)`,[randomUUID(),id,kind]);

  });return id;

}


