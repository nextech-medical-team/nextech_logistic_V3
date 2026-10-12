import ExcelJS from 'exceljs';
import {createHash,randomUUID} from 'node:crypto';
import {postalCellValue} from './import-postal-code.mjs';

const MAX_BYTES=12*1024*1024,MAX_FILES=50,MAX_ROWS=20000;
const key=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const fields={
 reference:['Order ID'],line:['N° de l’article de la commande','Order item ID'],
 status:['statut de la commande','Order status'],itemStatus:['statut de l’article de la commande','Order item status'],
 sku:['contribution SKU','SKU contribution'],temuSku:['N° SKU','SKU ID'],
 quantity:['quantité achetée','Quantity purchased'],remaining:['quantité à expédier','Quantity to ship'],shipped:['quantité expédiée','Quantity shipped'],cancelled:['quantité annulée','Quantity cancelled'],
 name:['nom du destinataire','Recipient name'],first:['prénom du destinataire','Recipient first name'],last:['nom de famille du destinataire','Recipient last name'],
 street1:['adresse d’expédition 1','Ship address 1'],street2:['adresse d’expédition 2','Ship address 2'],street3:['adresse d’expédition 3','Ship address 3'],
 city:['ville d’expédition','Ship city'],region:['état de l’expédition','Ship state'],postal:['code postal d’expédition (L’expédition doit être effectuée au code postal suivant.)','Ship postal code'],
 country:['pays d’expédition','Ship country'],phone:['numéro de téléphone du destinataire','Recipient phone number'],email:['e-mail virtuel','Virtual email'],date:['date d’achat','Purchase date'],
};
export const temuExcelHeaders=Object.fromEntries(Object.entries(fields).map(([f,names])=>[f,names[0]]));
const required=['reference','line','status','itemStatus','sku','quantity','remaining','shipped','cancelled','street1','city','postal','country','date'];
const countryCodes='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const countries=new Map(countryCodes.map(c=>[key(c),c]));
for(const locale of ['fr','en','it','de','es','nl','pl','pt']){
 const names=new Intl.DisplayNames([locale],{type:'region'});
 for(const c of countryCodes)countries.set(key(names.of(c)),c);
}
countries.set('uk','GB');countries.set('czechrepublic','CZ');countries.set('turkey','TR');
function cellText(cell){
 const v=postalCellValue(cell);
 if(v==null)return '';
 if(v instanceof Date)return v.toISOString();
 if(typeof v==='object'){
  if('formula' in v||'sharedFormula' in v||v.hyperlink||v.error)throw Error('Formule, lien ou erreur Excel : exporter les valeurs uniquement');
  if(v.richText)return v.richText.map(r=>r.text).join('').trim();
  throw Error('Cellule Excel non prise en charge');
 }
 if(typeof v==='number'&&(!Number.isFinite(v)||Math.abs(v)>Number.MAX_SAFE_INTEGER))throw Error('Nombre Excel invalide ou trop grand : exporter les identifiants en texte');
 return String(v).trim();
}
export function temuExcelDate(value){
 if(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value)))return new Date(value).toISOString();
 const m=value.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+[^()]*\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)$/i);
 const months=['jan janv january janvier','feb fev fevr february fevrier','mar mars march','apr avr april avril','may mai','jun juin june','jul juil juillet july','aug aout august','sep sept septembre september','oct octobre october','nov novembre november','dec decembre december'];
 const month=m?months.findIndex(v=>v.split(' ').includes(key(m[2]))):-1;
 if(!m||month<0)throw Error('Date d’achat invalide ou fuseau horaire absent');
 const [day,year,hour,minute,second,offsetHour,offsetMinute]=[m[1],m[3],m[4],m[5],m[6]||0,m[8],m[9]||0].map(Number);
 const utc=new Date(Date.UTC(year,month,day,hour,minute,second));
 if(utc.getUTCFullYear()!==year||utc.getUTCMonth()!==month||utc.getUTCDate()!==day||hour>23||minute>59||second>59||offsetHour>14||offsetMinute>59)throw Error('Date d’achat invalide');
 return new Date(utc.getTime()-(m[7]==='+'?1:-1)*(offsetHour*60+offsetMinute)*60000).toISOString();
}
function integer(value,positive=false){
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||(positive&&Number(value)===0))throw Error('Quantité entière '+(positive?'positive':'positive ou nulle')+' requise');
 return Number(value);
}
function inputFiles(files){
 if(!Array.isArray(files)||!files.length||files.length>MAX_FILES)throw Error('Sélectionnez de 1 à 50 fichiers Excel');
 let total=0;
 return files.map(f=>{
  if(!f||typeof f.filename!=='string'||f.filename.length>255||!f.filename.toLowerCase().endsWith('.xlsx')||typeof f.content!=='string'||!f.content||f.content.length%4||f.content.length>Math.ceil(MAX_BYTES/3)*4||! /^[A-Za-z0-9+/]*={0,2}$/.test(f.content))throw Error('Fichier XLSX invalide');
  const buffer=Buffer.from(f.content,'base64');total+=buffer.length;
  if(total>MAX_BYTES)throw Error('Les fichiers sélectionnés dépassent 12 Mo au total ; importez-les en plusieurs lots');
  return {filename:f.filename,buffer};
 });
}
export async function parseTemuExcelFiles(files){
 const inputs=inputFiles(files),digest=createHash('sha256').update('temu-excel-v1'),groups=new Map(),errors=[],fileSummaries=[];
 let rowCount=0,repeatedLines=0,totalExpanded=0;
 for(const {filename,buffer}of inputs){
  digest.update(JSON.stringify([filename,buffer.length])).update(buffer);
  const summary={filename,rows:0,orders:0,countries:[]};fileSummaries.push(summary);
  try{
   if(buffer.readUInt32LE(0)!==0x04034b50)throw Error('Classeur XLSX invalide');
   let expanded=0;
   for(let i=0;i+46<=buffer.length;i++)if(buffer.readUInt32LE(i)===0x02014b50){expanded+=buffer.readUInt32LE(i+24);if(expanded>80*1024*1024)throw Error('Classeur décompressé trop volumineux');i+=45;}
   totalExpanded+=expanded;if(totalExpanded>120*1024*1024)throw Error('Lot décompressé trop volumineux ; importez moins de fichiers à la fois');
   const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);
   const candidates=[];
   for(const sheet of book.worksheets){
    // Excel/LibreOffice may format the last worksheet row without data.
    const populated=[];let width=0;
    sheet.eachRow(row=>{let hasData=false;row.eachCell(cell=>{const v=cell.value;if(v!==null&&v!==undefined&&(typeof v!=='string'||v.trim()!=='')){hasData=true;width=Math.max(width,cell.col);}});if(hasData)populated.push(row);});
    if(width>100||populated.length>MAX_ROWS+30)throw Error('Classeur trop volumineux');
    for(let n=1;n<=Math.min(30,sheet.rowCount);n++){
     const row=sheet.getRow(n),headers=Array.from({length:width},(_,i)=>key(cellText(row.getCell(i+1))));
     if(!headers.includes('orderid'))continue;
     if(new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)throw Error('En-têtes dupliqués');
     const columns=Object.fromEntries(Object.entries(fields).map(([f,names])=>[f,headers.findIndex(h=>names.some(name=>key(name)===h))+1]));
     const missing=required.filter(f=>!columns[f]);
     if(missing.length)throw Error('Colonnes manquantes : '+missing.map(f=>temuExcelHeaders[f]).join(', '));
     if(!columns.name&&(!columns.first||!columns.last))throw Error('Colonne du destinataire absente');
     candidates.push({sheet,start:n+1,columns,populated,width});break;
    }
   }
   if(candidates.length!==1)throw Error(candidates.length?'Plusieurs feuilles de commandes : conserver un seul rapport par fichier':'En-tête Order ID introuvable dans les 30 premières lignes');
   const {sheet,start,columns,populated,width}=candidates[0],references=new Set(),fileCountries=new Set();let unreadableReference=false;
   for(const row of populated){
    const n=row.number;if(n<start)continue;
    if(++rowCount>MAX_ROWS)throw Error('Lot limité à 20 000 lignes produits');
    summary.rows++;let reference='';
    try{
     reference=cellText(row.getCell(columns.reference));
     if(!/^PO-[A-Za-z0-9-]{3,100}$/.test(reference))throw Error('Référence TEMU Order ID absente ou invalide');
     references.add(reference);
     if(!groups.has(reference))groups.set(reference,{reference,files:[],lines:[],issues:[],country:null});
     const order=groups.get(reference);if(!order.files.includes(filename))order.files.push(filename);
     const values=Object.fromEntries(Object.entries(columns).map(([f,c])=>[f,c?cellText(row.getCell(c)):'']));
     const raw=Object.fromEntries(Array.from({length:width},(_,i)=>[cellText(sheet.getRow(start-1).getCell(i+1)),cellText(row.getCell(i+1))]).filter(([h])=>h));
     const country=countries.get(key(values.country));if(!country)throw Error('Pays absent ou non reconnu : '+values.country);
     fileCountries.add(country);order.country??=country;
     const name=values.name||[values.first,values.last].filter(Boolean).join(' ');
     const address={name,street:[values.street1,values.street2,values.street3].filter(Boolean).join(', '),city:values.city,region:values.region,postal:values.postal,country,phone:values.phone,email:values.email};
     if(['FR','IT'].includes(country)&&/^\d{1,4}$/.test(address.postal))address.postal=address.postal.padStart(5,'0');
     if(!name||!values.street1||!address.city||!address.postal)throw Error('Destinataire ou adresse de livraison incomplets');
     if([name,values.street1,address.city,address.postal].some(v=>v.includes('***')))throw Error('Adresse masquée : exporter les coordonnées complètes');
     if(!values.sku||!values.line)throw Error('Référence vendeur ou numéro de ligne TEMU absent');
     if(!['nonexpedie','unshipped'].includes(key(values.status))||!['nonexpedie','unshipped'].includes(key(values.itemStatus)))throw Error('Commande non importable : seuls les articles non expédiés sont acceptés');
     const quantity=integer(values.quantity,true),remaining=integer(values.remaining,true),shipped=integer(values.shipped),cancelled=integer(values.cancelled);
     if(shipped||cancelled||remaining!==quantity)throw Error('Commande partiellement expédiée ou annulée : vérification manuelle requise');
     const sourceDate=temuExcelDate(values.date),identity=JSON.stringify([address,sourceDate]);
     if(order.identity&&order.identity!==identity)throw Error('Informations contradictoires pour la même commande (pays, adresse ou date)');
     order.identity=identity;order.address=address;order.source_date=sourceDate;order.recipient=name;
     const line={source_line:values.line,source_sku:values.sku,quantity,source_payload:{origin:'temu_excel',temuOrderSn:values.line,skuId:values.temuSku,marketplaceQuantity:quantity,excel:raw},file:filename,row:n};
     const prior=order.lines.find(l=>l.source_line===line.source_line);
     if(prior){
      if(JSON.stringify([prior.source_sku,prior.quantity,prior.source_payload])!==JSON.stringify([line.source_sku,line.quantity,line.source_payload]))throw Error('Ligne TEMU répétée avec des données différentes');
      repeatedLines++;continue;
     }
     order.lines.push(line);
    }catch(e){const issue={filename,row:n,reference:reference||null,message:e.message};errors.push(issue);if(groups.has(reference))groups.get(reference).issues.push(issue.message);else unreadableReference=true;}
   }
   summary.orders=references.size;summary.countries=[...fileCountries];
   if(unreadableReference)throw Error('Une ligne a une référence illisible : corriger le fichier avant import');
   if(!summary.rows)throw Error('Fichier sans commande');
  }catch(e){
   // A failed workbook must never leave a partially accepted order behind.
   for(const order of groups.values())if(order.files.includes(filename))order.issues.push('Fichier incomplet : '+e.message);
   errors.push({filename,row:null,reference:null,message:e.message});summary.error=e.message;
   if(rowCount>MAX_ROWS)throw Error('Lot limité à 20 000 lignes produits');
   if(totalExpanded>120*1024*1024)throw e;
  }
 }
 return {hash:digest.digest('hex'),rows:rowCount,repeatedLines,files:fileSummaries,orders:[...groups.values()],errors};
}
async function existingReferences(db,references){
 return new Set((await db.query("SELECT DISTINCT reference,source_reference FROM orders WHERE channel='temu' AND (reference=ANY($1::text[]) OR source_reference=ANY($1::text[]))",[references])).rows.flatMap(r=>[r.reference,r.source_reference].filter(Boolean)));
}
export async function previewTemuExcel(db,files){
 const parsed=await parseTemuExcelFiles(files),existing=await existingReferences(db,parsed.orders.map(o=>o.reference));
 const orders=parsed.orders.map(o=>({reference:o.reference,country:o.country,recipient:o.recipient||'',files:o.files,lines:o.lines.length,quantity:o.lines.reduce((n,l)=>n+l.quantity,0),issues:[...new Set(o.issues)],duplicate:existing.has(o.reference),eligible:!o.issues.length&&o.lines.length>0&&!existing.has(o.reference)}));
 const countries=[...new Set(orders.map(o=>o.country||'À vérifier'))].sort().map(country=>{
  const rows=orders.filter(o=>(o.country||'À vérifier')===country);
  return {country,total:rows.length,newCount:rows.filter(o=>o.eligible).length,duplicateCount:rows.filter(o=>o.duplicate).length,errorCount:rows.filter(o=>o.issues.length).length};
 });
 return {...parsed,orders,countries,newCount:orders.filter(o=>o.eligible).length,duplicateCount:orders.filter(o=>o.duplicate).length};
}
export async function confirmTemuExcel(db,input,user){
 if(!Array.isArray(input.selection)||!input.selection.length||input.selection.length>MAX_ROWS||input.selection.some(r=>typeof r!=='string'))throw Error('Sélectionnez les commandes à importer');
 if(!/^[a-f0-9-]{36}$/i.test(input.requestId||''))throw Error('Identifiant de validation invalide');
 const parsed=await parseTemuExcelFiles(input.files);
 if(input.hash!==parsed.hash)throw Error('Les fichiers ont changé : relancez l’analyse');
 const selected=[...new Set(input.selection)].sort(),byReference=new Map(parsed.orders.map(o=>[o.reference,o]));
 for(const reference of selected){const o=byReference.get(reference);if(!o||o.issues.length||!o.lines.length)throw Error('Commande absente ou invalide dans la sélection : '+reference);}
 const signature=createHash('sha256').update(JSON.stringify(['temu-excel-v1',parsed.hash,selected])).digest('hex');
 return db.transaction(async tx=>{
  const receipt=await tx.query('INSERT INTO import_receipts(id,signature) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[input.requestId,signature]);
  if(!receipt.rows.length){
   const prior=(await tx.query('SELECT signature,result FROM import_receipts WHERE id=$1',[input.requestId])).rows[0];
   if(prior.signature!==signature)throw Error('Validation déjà utilisée pour une autre sélection');
   if(!prior.result||prior.result.cancellation)throw Error('Validation indisponible : relancez l’analyse');
   return {...prior.result,replayed:true};
  }
  const existing=await existingReferences(tx,selected),results=[];
  for(const reference of selected){
   const o=byReference.get(reference);
   if(existing.has(reference)){results.push({reference,country:o.country,status:'skipped',reason:'Déjà présente dans V3'});continue;}
   const id=randomUUID(),at=new Date().toISOString(),note='Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation.';
   const suspension={active:true,note,version:randomUUID(),updatedAt:at,updatedBy:user.email};
   const payload={origin:'temu_excel',country:o.country,temuExcel:{files:o.files,importedAt:at,importedBy:user.email,requestId:input.requestId},manualPreparationRequired:true};
   const added=await tx.query(`INSERT INTO orders(id,channel,reference,source_reference,recipient,address,source_date,source_payload,carrier,label_status,erp_status,tracking_status,resolution_pending_resume,suspension,issue)
    VALUES($1,'temu',$2,$2,$3,$4,$5,$6,'temu','blocked','pending','not_shipped',true,$7,$8) ON CONFLICT(channel,reference) DO NOTHING RETURNING id`,[id,reference,o.recipient,JSON.stringify(o.address),o.source_date,JSON.stringify(payload),JSON.stringify(suspension),note]);
   if(!added.rows.length){results.push({reference,country:o.country,status:'skipped',reason:'Importée entre-temps'});continue;}
   for(const l of o.lines)await tx.query('INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,l.source_line,l.source_sku,l.quantity,JSON.stringify(l.source_payload)]);
   await tx.query('INSERT INTO order_suspension_events(id,order_id,action,user_email,note,state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,'import_held',user.email,note,JSON.stringify(suspension)]);
   results.push({reference,country:o.country,status:'created',orderId:id});
  }
  const created=results.filter(r=>r.status==='created').length,skipped=results.length-created;
  const result={created,skipped,excluded:parsed.orders.length-selected.length,errors:parsed.errors,results,message:`${created} commandes TEMU importées en attente de validation ; ${skipped} déjà présentes ignorées. Aucune préparation lancée.`};
  await tx.query('UPDATE import_receipts SET result=$2 WHERE id=$1',[input.requestId,JSON.stringify(result)]);
  await tx.query('INSERT INTO audit(user_email,action,detail) VALUES($1,$2,$3)',[user.email,'import.temu.excel',JSON.stringify({requestId:input.requestId,files:parsed.files.map(f=>f.filename),created,skipped})]);
  return result;
 });
}
export async function temuExcelImportRoutes({p,req,res,user,body,json,permitted,db}){
 if(!['/api/import/temu/preview','/api/import/temu/confirm'].includes(p)||req.method!=='POST')return false;
 permitted(user,['admin','manager','operator']);
 const input=await body(req);
 json(res,200,p.endsWith('/preview')?await previewTemuExcel(db,input.files):await confirmTemuExcel(db,input,user));
 return true;
}
