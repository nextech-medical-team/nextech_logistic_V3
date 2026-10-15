import {initializeImportReceptions,importCandidates,matchImport,recordImportReception,shopIdentity} from './import-reception.mjs';
import {postalHeaders,postalCellValue,importPostalCode} from './import-postal-code.mjs';
import {cancelledImportSql,releaseCancelledImportReferences} from './cancelled-import-reimport.mjs';
import {tenderPhone} from './tender-label-fields.mjs';
import {retainVisibleOrder} from './order-visibility.mjs';
import ExcelJS from 'exceljs';
import {parseShopifyRows,completeShopifyFileOrders} from './shopify-file-import.mjs';

import { randomUUID,createHash } from 'node:crypto';

import { channelName } from './domain.mjs';



function value(v,preserve=false){

  if(v==null)return '';

  if(v instanceof Date)return v.toISOString();

  if(typeof v==='object'){

    if('formula' in v||'sharedFormula' in v)throw new Error('Les formules ne sont pas acceptées : exporter les valeurs.');

    if(v.richText)return v.richText.map(x=>x.text).join('');

    if(v.text)return v.text;

  }

  return preserve?String(v):String(v).trim();

}

const key=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');

export function delimited(text,delimiter='\t'){

  const rows=[];let row=[],field='',quoted=false;

  for(let i=0;i<text.length;i++){

    const c=text[i];

    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(quoted||field==='')quoted=!quoted;else field+=c;}

    else if(c===delimiter&&!quoted){row.push(field);field='';}

    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x!==''))rows.push(row);row=[];field='';}

    else field+=c;

  }

  if(quoted)throw new Error('Champ texte non fermé');

  row.push(field);if(row.some(x=>x!==''))rows.push(row);

  return rows;

}

export async function readTable(buffer,filename,{exactNotes=false,shopifyRecords=false}={}){

  if(buffer.length>12*1024*1024)throw new Error('Fichier limité à 12 Mo');

  let rows;

  if(/\.xlsx$/i.test(filename)){

    // Reject oversized ZIP declarations before ExcelJS expands the workbook.

    let expanded=0;

    for(let i=0;i+46<buffer.length;i++)if(buffer.readUInt32LE(i)===0x02014b50){expanded+=buffer.readUInt32LE(i+24);if(expanded>80*1024*1024)throw new Error('Classeur décompressé trop volumineux');i+=45;}

    const w=new ExcelJS.Workbook();await w.xlsx.load(buffer);

    const sheet=w.worksheets[0];if(!sheet)throw new Error('Classeur vide');

    const columnCount=sheet.columnCount;

    if(sheet.rowCount>100001||columnCount>100)throw new Error('Classeur trop volumineux');

    rows=[];sheet.eachRow(r=>rows.push(Array.from({length:columnCount},(_,i)=>value(postalHeaders.has(key(value(sheet.getRow(1).getCell(i+1).value)))?postalCellValue(r.getCell(i+1)):r.getCell(i+1).value,exactNotes&&key(value(sheet.getRow(1).getCell(i+1).value))==='notes'))));

  }else if(/\.(txt|tsv|csv)$/i.test(filename)){

    let text;

    try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('windows-1252').decode(buffer);}

    text=text.replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0];

    const delimiter=first.includes('\t')?'\t':first.includes(';')?';':',';

    rows=delimited(text,delimiter);

  }else throw new Error('Formats acceptés : TXT, TSV, CSV, XLSX');

  if(shopifyRecords){
    // Excel sometimes saves an entire CSV record in each cell of column A.
    const packedHeader=rows[0]?.length===1?rows[0][0]:null;
    const headerText=packedHeader||rows[0]?.join(',')||'';
    const delimiter=headerText.includes('\t')?'\t':headerText.includes(';')?';':',';
    if(packedHeader){
      const candidates=delimited(packedHeader,delimiter);
      if(candidates.length===1&&['name','lineitemsku','lineitemquantity'].every(h=>candidates[0].map(key).includes(h))){
        rows=rows.map((row,i)=>{
          if(row.length!==1)throw Error(`Export Shopify en colonne unique incohérent ligne ${i+1}`);
          const cells=delimited(row[0],delimiter);
          if(cells.length!==1)throw Error(`Plusieurs enregistrements Shopify dans la cellule ligne ${i+1}`);
          return cells[0];
        });
      }
    }
    if(rows[0]?.length>1){
      const width=rows[0].length;
      rows=rows.map((row,i)=>{
        if(i===0)return row;
        if(row.length===1){const nested=delimited(row[0],delimiter);if(nested.length===1&&nested[0].length>1&&nested[0].length<=width)return nested[0];}
        if(row.length>width||(row.length===1&&row[0].includes(delimiter)))throw Error(`Nombre de colonnes Shopify incorrect ligne ${i+1} : ${row.length} au lieu de ${width}`);
        return row;
      });
    }
  }

  if(rows.length<2)throw new Error('Fichier sans données');

  const headers=rows.shift().map(key);

  if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)throw new Error('En-têtes dupliqués');

  return rows.map((r,i)=>Object.assign({row:i+2},Object.fromEntries(headers.map((h,j)=>[h,value(r[j],exactNotes&&h==='notes')]))));

}

function number(v){const n=Number(String(v).replace(/\s/g,'').replace(',','.'));if(!Number.isFinite(n)||n<=0)throw new Error('Quantité positive requise');return n;}

export async function importMapping(db,buffer,filename){

  const rows=await readTable(buffer,filename);const seen=new Set();

  const data=rows.map(r=>{

    const c=channelName(r.gestionnaire),s=r.skugestionnaire,t=r.skuerplain;

    if(!['amazon','shopify','temu','relay','rakuten'].includes(c)||!s||!t)throw new Error(`Mapping incomplet ligne ${r.row}`);

    const k=c+'\0'+s;if(seen.has(k))throw new Error(`Mapping dupliqué ligne ${r.row}`);seen.add(k);

    return {channel:c,source_sku:s,target_sku:t,source_qty:number(r.quantitegestionnaire),target_qty:number(r.quantiteerplain),notes:r.notes||''};

  });

  await db.transaction(async tx=>{

    await tx.query(`INSERT INTO mappings(channel,source_sku,target_sku,source_qty,target_qty,notes) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric,notes text) ON CONFLICT(channel,source_sku) DO UPDATE SET target_sku=EXCLUDED.target_sku,source_qty=EXCLUDED.source_qty,target_qty=EXCLUDED.target_qty,notes=EXCLUDED.notes,updated_at=now()`,[JSON.stringify(data)]);

    await tx.query(`UPDATE jobs SET status='pending',available_at=now(),error=null WHERE kind='label' AND status='blocked'`);

  });

  return {rows:data.length,created:0,skipped:0,errors:[],message:`${data.length} correspondances ajoutées ou mises à jour`};

}



export async function parseOrders(buffer,filename,channel){

  if(!['amazon','tender','samples','shopify'].includes(channel))throw new Error('Canal d’import invalide');

  if(channel==='shopify')return parseShopifyRows(await readTable(buffer,filename,{shopifyRecords:true}));

  const rows=await readTable(buffer,filename,{exactNotes:channel==='tender'}),groups=new Map(),errors=[];

  let reference='';const invalid=new Set(),rawByRef=new Map(),sourceRows=new Map();

  for(const r of rows){

    const ref=channel==='amazon'?r.orderid:(r.referenceexterne||reference);

    if(channel!=='amazon'&&r.referenceexterne)reference=r.referenceexterne;

    if(ref){if(!rawByRef.has(ref))rawByRef.set(ref,[]);rawByRef.get(ref).push(r);}
    try{

      if(!ref)throw new Error('Référence commande absente');

      if(channel==='amazon')r.shippostalcode=importPostalCode(r.shippostalcode,r.shipcountry);
      else r.adressedelivraisoncodepostal=importPostalCode(r.adressedelivraisoncodepostal,r.adressedelivraisonpays);
      const sku=channel==='amazon'?r.sku:r.skuproduit;

      if(!sku)throw new Error('SKU absent');

      const quantity=number(channel==='amazon'?r.quantitypurchased:r.qte);
      if(['tender','samples'].includes(channel)){
       const signature=JSON.stringify(Object.entries(r).filter(([k])=>!['row','referenceexterne'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
       const seen=sourceRows.get(ref)||new Set();if(seen.has(signature))throw Error('Lignes source identiques sans identifiant distinct : quantité à rapprocher');seen.add(signature);sourceRows.set(ref,seen);
      }


      if(!groups.has(ref)){

        const address=channel==='amazon'?{name:r.recipientname,street:[r.shipaddress1,r.shipaddress2,r.shipaddress3].filter(Boolean).join(', '),postal:r.shippostalcode,city:r.shipcity,country:r.shipcountry,phone:r.shipphonenumber||r.buyerphonenumber}:{name:r.adressedelivraisonnom||r.client,street:[r.adressedelivraisonadresse1,r.adressedelivraisonadresse2].filter(Boolean).join(', '),postal:r.adressedelivraisoncodepostal,city:r.adressedelivraisonville,country:r.adressedelivraisonpays,phone:channel==='tender'?tenderPhone(r.numerodetelephone||r.adressedelivraisontelephone,r.adressedelivraisonpays):r.adressedelivraisontelephone};
        if(channel==='tender'){address.street1=r.adressedelivraisonadresse1;address.street2=r.adressedelivraisonadresse2;}

        groups.set(ref,{id:randomUUID(),channel,reference:ref,recipient:address.name||'',address,source_date:channel==='amazon'?r.purchasedate:r.datedudocument,source_payload:r,lines:[]});

      }

      const o=groups.get(ref),sourceLine=channel==='amazon'?`${r.orderitemid||r.row}:${sku}`:String(r.row);

      if(!o.lines.some(l=>l.source_line===sourceLine))o.lines.push({id:randomUUID(),order_id:o.id,source_line:sourceLine,source_sku:sku,quantity,source_payload:r});

      else {invalid.add(ref);throw new Error('Ligne produit dupliquée dans le fichier');}

    }catch(e){if(ref){invalid.add(ref);if(!groups.has(ref))groups.set(ref,{id:randomUUID(),channel,reference:ref,recipient:'',address:{},source_date:null,source_payload:r,lines:[]});const o=groups.get(ref);o.visibilityHold=true;o.visibilityReason='Import ligne '+r.row+' : '+e.message;}errors.push({row:r.row,reference:ref||null,message:e.message});}

  }

  const valid=[...groups.values()].map(o=>invalid.has(o.reference)?{...o,source_payload:{...o.source_payload,visibilityRows:rawByRef.get(o.reference)},lines:[],visibilityHold:true,visibilityReason:o.visibilityReason||'Ligne dupliquée · Import à corriger'}:o);

  return {rows:rows.length,valid,errors};
}

export async function previewOrders(db,buffer,filename,channel,options={}){
  const parsed=await parseOrders(buffer,filename,channel);
  if(channel==='shopify')await completeShopifyFileOrders(parsed,options.shopifyReader);
  const candidates=await importCandidates(db,parsed.valid,channel);
  const byRef=new Map(parsed.valid.map(o=>[o.reference,matchImport(o,candidates,channel)]).filter(([,m])=>m.existing).map(([r,m])=>[r,{...m.existing,identityAmbiguous:m.ambiguous}]));
  const sourceLines=(await db.query('SELECT order_id,source_sku,quantity FROM lines WHERE order_id=ANY($1::text[])',[candidates.map(o=>o.id)])).rows;
  const signature=rows=>{const sums=new Map();for(const row of rows)sums.set(row.source_sku,(sums.get(row.source_sku)||0)+Number(row.quantity));return JSON.stringify([...sums].sort());};
  for(const o of parsed.valid){const old=byRef.get(o.reference);if(old&&!old.identityAmbiguous&&signature(o.lines)!==signature(sourceLines.filter(l=>l.order_id===old.id)))old.receivedDifference=true;}
  const orders=parsed.valid.map(o=>({reference:o.reference,recipient:o.recipient,lines:o.lines.length,quantity:o.lines.reduce((n,l)=>n+l.quantity,0),issue:byRef.get(o.reference)?.identityAmbiguous?'Identité à rapprocher : réception conservée, aucun nouveau BdC':byRef.get(o.reference)?.receivedDifference?'Réception différente : produits ou quantités à rapprocher, commande existante conservée':o.visibilityReason||null,recoverable:!!byRef.get(o.reference)?.source_payload?.visibilityHold,duplicate:byRef.has(o.reference)&&!byRef.get(o.reference)?.source_payload?.visibilityHold,existing:byRef.get(o.reference)||null}));
  return {rows:parsed.rows,errors:parsed.errors,orders,newCount:orders.filter(o=>!o.duplicate).length,duplicateCount:orders.filter(o=>o.duplicate).length};
}

export async function importOrders(db,buffer,filename,channel,selection,options={}){
  await initializeImportReceptions(db);
  const parsed=await parseOrders(buffer,filename,channel),rows=parsed.rows,errors=parsed.errors;
  if(selection!==undefined&&(!Array.isArray(selection)||selection.some(r=>typeof r!=='string')))throw new Error('Sélection de commandes invalide');
  const chosen=selection===undefined?null:new Set(selection);
  const valid=parsed.valid.filter(o=>!chosen||chosen.has(o.reference));
  if(channel==='shopify')await completeShopifyFileOrders({...parsed,valid},options.shopifyReader);
  const duplicates=options.duplicateSelection||[];
  if(!Array.isArray(duplicates)||duplicates.some(r=>typeof r!=='string'||!chosen?.has(r)))throw new Error('Sélection de doublons invalide');
  if(duplicates.length&&!/^[a-f0-9-]{36}$/i.test(options.requestId||''))throw new Error('Identifiant de validation requis');
  const signature=createHash('sha256').update(buffer).update(JSON.stringify([channel,filename,selection,duplicates])).digest('hex');
  let created=0,copies=0,recovered=0,replayed=null,conflicts=[];

  await db.transaction(async tx=>{
    if(db.kind==='postgres')await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('nextech:import-order-identity',0))");

    if(options.requestId){
      if(!/^[a-f0-9-]{36}$/i.test(options.requestId))throw new Error('Identifiant de validation invalide');
      const inserted=await tx.query('INSERT INTO import_receipts(id,signature) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[options.requestId,signature]);
      if(!inserted.rows.length){const prior=(await tx.query('SELECT signature,result FROM import_receipts WHERE id=$1',[options.requestId])).rows[0];if(prior.signature!==signature)throw new Error('Validation déjà utilisée pour une autre sélection');if(prior.result?.cancellation)throw new Error('Cet import a été annulé. Analysez de nouveau votre fichier avant de valider une nouvelle sélection.');replayed=prior.result;return;}
    }
    await releaseCancelledImportReferences(tx,channel,valid.map(o=>o.reference));
    const candidates=await importCandidates(tx,valid,channel);
    const matches=new Map(valid.map(o=>[o.reference,matchImport(o,candidates,channel)]));
    const existing=valid.map(o=>{const m=matches.get(o.reference);return m.existing?{...m.existing,reference:o.reference,identityAmbiguous:m.ambiguous}:null;}).filter(Boolean);
    const byRef=new Map(existing.map(o=>[o.reference,o.id]));
    conflicts=existing.filter(o=>o.identityAmbiguous).map(o=>({reference:o.reference,orderId:o.id,message:'Identité commerciale à rapprocher ; réception conservée, aucun nouveau document'}));
    for(const o of valid.filter(o=>!o.visibilityHold&&!matches.get(o.reference)?.ambiguous)){const old=existing.find(e=>e.reference===o.reference&&e.source_payload?.visibilityHold);if(!old)continue;
     await tx.query('UPDATE orders SET recipient=$2,address=$3,source_date=$4,source_payload=$5,issue=$6 WHERE id=$1',[old.id,o.recipient,JSON.stringify(o.address),o.source_date,JSON.stringify({...o.source_payload,visibilityHold:false}),'Données récupérées · Préparation à vérifier']);
     for(const l of o.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[l.id,old.id,l.source_line,l.source_sku,l.quantity,JSON.stringify(l.source_payload)]);recovered++;
    }
    for(const o of valid){o.source_reference=o.reference;
     if(channel==='shopify'&&!byRef.has(o.reference)&&candidates.some(c=>c.channel===channel&&c.reference===o.reference)){
      const shop=shopIdentity(o);if(!shop)throw Error('Boutique source à préciser');
      o.reference+=' / boutique '+shop;o.source_payload={...o.source_payload,importIdentityReference:true};
     }
    }

    for(const o of valid.filter(o=>o.visibilityHold&&!byRef.has(o.source_reference)))if(await retainVisibleOrder(tx,o,o.visibilityReason))created++;
    const result=await tx.query(`INSERT INTO orders(id,channel,reference,source_reference,duplicate_of,recipient,address,source_date,source_payload) SELECT id,channel,reference,source_reference,duplicate_of,recipient,address,source_date,source_payload FROM jsonb_to_recordset($1::jsonb) AS x(id text,channel text,reference text,source_reference text,duplicate_of text,recipient text,address jsonb,source_date text,source_payload jsonb) ON CONFLICT(channel,reference) DO NOTHING RETURNING id`,[JSON.stringify(valid.filter(o=>!o.visibilityHold&&(!byRef.has(o.source_reference)||o.duplicate_of)))]);

    const ids=new Set(result.rows.map(r=>r.id));created+=ids.size;

    const lines=valid.filter(o=>ids.has(o.id)).flatMap(o=>o.lines);

    await tx.query(`INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,order_id text,source_line text,source_sku text,quantity numeric,source_payload jsonb)`,[JSON.stringify(lines)]);

    const jobs=[...ids].flatMap(order_id=>['label','erp'].map(kind=>({id:randomUUID(),order_id,kind})));

    await tx.query(`INSERT INTO jobs(id,order_id,kind) SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,order_id text,kind text)`,[JSON.stringify(jobs)]);

    for(const o of parsed.valid){const original=o.source_reference||o.reference,selected=!chosen||chosen.has(original),match=matches.get(original),createdHere=ids.has(o.id);await recordImportReception(tx,o,{channel,filename,receiptId:options.requestId,orderId:createdHere?o.id:match?.existing?.id||null,outcome:!selected?'excluded':match?.ambiguous?'identity_review':createdHere?'created':o.visibilityHold?'invalid_received':'duplicate_received'});}
    if(options.requestId)await tx.query('UPDATE import_receipts SET result=$2 WHERE id=$1',[options.requestId,JSON.stringify({rows,created,copies,recovered,conflicts,excluded:parsed.valid.length-valid.length,skipped:valid.length-created,errors,message:`${created} commandes importées sans copie de doublon ; ${recovered} fiches complétées ; ${valid.length-created} déjà présentes ignorées`})]);
  });

  if(replayed)return {...replayed,replayed:true};
  return {rows,created,copies,recovered,conflicts,excluded:parsed.valid.length-valid.length,skipped:valid.length-created,errors,message:`${created} commandes importées sans copie de doublon ; ${recovered} fiches complétées ; ${valid.length-created} déjà présentes ignorées`};

}

