import ExcelJS from 'exceljs';
import {erplainAccount} from './erplain-accounts.mjs';
import {fileURLToPath} from 'node:url';
export const exportBlFields='id label status dated_at shipping_at shipping_address{label address_1 city postal_code country} line_items{id sku label quantity variant{id sku weight_amount weight_unit product{id label default_supplier{id label}} suppliers{supplier{id label} supplier_sku}}}';
export function aggregateBlLines(bl){
 const grouped=new Map();
 for(const l of bl.line_items||[]){if(l.quantity==null||l.quantity===''||!Number.isFinite(Number(l.quantity)))throw Error('Quantité BL invalide');const sku=l.variant?.sku||l.sku||'',key=l.variant?.id||sku||'line-'+l.id;
  if(!grouped.has(key))grouped.set(key,{sku,label:l.label||l.variant?.product?.label||'',quantity:0,variant:l.variant});grouped.get(key).quantity+=Number(l.quantity);
 }return [...grouped.values()];
}
export async function labelWorkbook(job,{api=erplainAccount(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),'live'),sourceApi=erplainAccount(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),'source')}={}){
 const book=new ExcelJS.Workbook();book.creator='NEXTECH LOGISTIC V3';book.created=new Date();
 const details=book.addWorksheet('BL et SKU'),issues=book.addWorksheet('Exceptions'),summary=book.addWorksheet('Extraction');
 const headers=['Ordre PDF','Pages PDF','Commande','Gestionnaire','BC Erplain','BL Erplain','ID BL Erplain','Date BL','Statut BL','Fournisseur principal Erplain','Fournisseurs associés Erplain','SKU Erplain','Produit','Quantité du BL','Poids unitaire','Unité de poids','Destinataire','Adresse','Code postal','Ville','Pays','Transporteur','Suivis des colis','Étiquettes du BL','Compte Erplain','Lecture Erplain','Source fournisseurs'];
 details.addRow(headers);issues.addRow(['Commande','BL Erplain','Problème']);summary.addRows([['Extraction des BL associés aux étiquettes','Valeur'],['PDF',job.filename],['Créé le (Paris)',new Date().toLocaleString('fr-FR',{timeZone:'Europe/Paris'})],['Classement',job.sort||'selection'],['Étiquettes PDF',job.labels],['Pages PDF',job.pages],['Quantités','Lignes des BL relues dans Erplain LIVE. Un BL compté une seule fois même avec plusieurs étiquettes.'],['Fournisseurs','Fournisseur principal et fournisseurs associés au produit Erplain ; non renseigné si absent.']]);
 const groups=new Map();for(const d of job.exportSources||[]){const s=d.source,o=s.order||{},bl=s.bl;
  if(!bl?.id){issues.addRow([d.reference,'','Étiquette incluse, mais BL Erplain non identifié ; aucune quantité inventée.']);continue;}
  const key=String(bl.id);if(!groups.has(key))groups.set(key,{...s,pages:[],labels:0,reference:d.reference});const g=groups.get(key);g.labels++;g.pages.push(...d.pages);
 }
 for(const item of job.items)for(const problem of item.problems)issues.addRow([item.reference,'',problem]);
 let verified=false,apiError;try{if(groups.size){await api.verify();verified=true;}}catch(e){apiError=e.message;}
 const all=[...groups.values()];let done=0,loaded=0,sourceVerified=false;const supplierCache=new Map();
 const hasSupplier=v=>v?.product?.default_supplier?.label||v?.suppliers?.some(s=>s.supplier?.label);
 async function prefetchSuppliers(data){
  const needed=new Map();for(const bl of Object.values(data))for(const l of bl?.line_items||[]){const v=l.variant||{},sku=v.sku||l.sku;if(sku&&!hasSupplier(v)&&!supplierCache.has(sku))needed.set(sku,v);}
  if(!needed.size)return;
  try{if(!sourceVerified){await sourceApi.verify();sourceVerified=true;}
   const skus=[...needed.keys()],variants=[];let page=1;
   while(true){const r=await sourceApi.request('query V3ExportSupplier($where:QueryVariantsWhereWhereConditions!,$page:Int!){Variants(first:100,page:$page,where:$where){data{id sku active product{active default_supplier{id label}} suppliers{supplier{id label}}}}}',{where:{column:'SKU',operator:skus.length===1?'EQ':'IN',value:skus.length===1?skus[0]:skus},page});const rows=r.Variants?.data||[];variants.push(...rows);if(rows.length<100)break;if(++page>100)throw Error('Lecture fournisseurs incomplète');}
   for(const [sku,v]of needed){const matches=variants.filter(x=>x.sku===sku&&x.active!==false&&x.product?.active!==false);supplierCache.set(sku,matches.length===1?{variant:matches[0],source:'Erplain source · lecture seule'}:{variant:v,source:'Non identifié',warning:'Fournisseur non identifié : SKU absent ou ambigu dans Erplain source'});}
  }catch(e){for(const [sku,v]of needed)supplierCache.set(sku,{variant:v,source:'Non vérifié',warning:'Fournisseur non vérifié : '+e.message});}
 }
 function supplierFor(v,sku){return hasSupplier(v)?{variant:v,source:'Erplain LIVE'}:supplierCache.get(sku)||{variant:v,source:'Non renseigné'};}
 for(let offset=0;offset<all.length;offset+=5){const batch=all.slice(offset,offset+5);let data={};let error=apiError;
  if(verified)try{const declarations=batch.map((g,i)=>`$id${i}:ID!`).join(','),fields=batch.map((g,i)=>`b${i}:ShippingOrder(id:$id${i}){${exportBlFields}}`).join(' ');data=await api.request(`query V3ExportBL(${declarations}){${fields}}`,Object.fromEntries(batch.map((g,i)=>['id'+i,String(g.bl.id)])));}catch(e){error=e.message;}
  await prefetchSuppliers(data);
  for(const [i,g]of batch.entries()){const bl=data['b'+i],o=g.order||{};
   if(error||!bl?.line_items?.length){issues.addRow([g.reference,g.bl.label||String(g.bl.id),error?'Lecture API Erplain impossible : '+error:'BL absent ou lignes non reçues']);}
   else{let lines;try{lines=aggregateBlLines(bl);}catch(e){issues.addRow([g.reference,bl.label,e.message]);lines=[];}if(lines.length)loaded++;for(const l of lines){const v=l.variant||{},found=await supplierFor(v,l.sku),sv=found.variant,suppliers=[...new Set((sv.suppliers||[]).map(x=>x.supplier?.label).filter(Boolean))],principal=sv.product?.default_supplier?.label||'',a=bl.shipping_address||{};
    details.addRow([Math.min(...g.pages),[...new Set(g.pages)].join(', '),g.reference,o.account_manager||o.channel||'',o.erp_live?.bc?.label||'',bl.label,String(bl.id),bl.dated_at||'',bl.status||'',principal||'Non renseigné',suppliers.join(' ; ')||'Non renseigné',l.sku,l.label,l.quantity,v.weight_amount??null,v.weight_unit||'',a.label||o.recipient||'',a.address_1||'',String(a.postal_code||''),a.city||'',a.country||'',g.carrier||o.carrier||'',(g.tracking||[]).join(' ; '),g.labels,'Erplain LIVE',new Date().toISOString(),found.source]);
    if(found.warning||!principal&&!suppliers.length)issues.addRow([g.reference,bl.label,l.sku+' · '+(found.warning||'Fournisseur non renseigné dans Erplain')]);
    if(!l.sku)issues.addRow([g.reference,bl.label,'SKU Erplain non renseigné sur une ligne du BL']);
   }}done++;job.percent=85+Math.floor(done/Math.max(1,all.length)*14);job.stage=`Excel : lecture des BL ${done}/${all.length}`;
  }
 }
 summary.addRows([['BL identifiés',groups.size],['BL relus',loaded],['Lignes SKU',details.rowCount-1],['Exceptions',issues.rowCount-1]]);
 for(const sheet of [details,issues,summary]){sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:sheet.columnCount}};sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF164B58'}};sheet.getRow(1).height=34;
  sheet.columns.forEach((c,i)=>{c.width=sheet===details?([1,2,6,7,8,14,15,16,19,21,24].includes(i+1)?18:28):i===0?32:70;});sheet.eachRow((row,n)=>{row.alignment={vertical:'top',wrapText:true};if(n>1&&n%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F6F5'}};});}
 details.getColumn(14).numFmt='0.######';details.getColumn(19).numFmt='@';
 job.excelRows=details.rowCount-1;job.excelWarnings=issues.rowCount-1;job.excelBlCount=loaded;job.excelFilename=job.filename.replace(/^Etiquettes_/,'BL-et-SKU_').replace(/\.pdf$/,'.xlsx');
 return Buffer.from(await book.xlsx.writeBuffer());
}


