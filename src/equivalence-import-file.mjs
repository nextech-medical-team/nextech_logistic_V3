import ExcelJS from 'exceljs';
export const importHeaders=['Numéro de commande','SKU de base','SKU de remplacement','Qté de remplacement'];
const normalized=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
function scalar(cell){
 const value=cell.value;
 if(value==null)return '';
 if(typeof value==='string'||typeof value==='number')return String(value).trim();
 if(value.richText)return value.richText.map(x=>x.text).join('').trim();
 throw Error('Formules, liens et valeurs complexes interdits : ligne '+cell.row+', colonne '+cell.col);
}
export async function parseEquivalenceFile(base64){
 if(typeof base64!=='string'||!base64||base64.length>14*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw Error('Fichier XLSX invalide ou trop volumineux (10 Mo maximum)');
 const bytes=Buffer.from(base64,'base64');if(bytes.length>10*1024*1024||bytes[0]!==80||bytes[1]!==75)throw Error('Un fichier Excel XLSX est requis');
 const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
 const sheet=book.getWorksheet('Onglet type');if(!sheet)throw Error('Onglet « Onglet type » absent');
 if(sheet.rowCount>1001||sheet.columnCount>30)throw Error('Maximum 1 000 lignes et 30 colonnes');
 const header=sheet.getRow(1),columns=importHeaders.map(name=>{
  const found=[];header.eachCell((cell,col)=>{if(normalized(scalar(cell))===normalized(name))found.push(col);});
  if(found.length!==1)throw Error('Colonne absente ou répétée : '+name);return found[0];
 });
 const rows=[],seen=new Set();
 for(let i=2;i<=sheet.rowCount;i++){
  const vals=columns.map(c=>scalar(sheet.getRow(i).getCell(c)));if(vals.every(v=>v===''))continue;
  const [reference,sku,replacementSku,q]=vals;
  const quantity=/^\d+(?:[.,]\d{1,6})?$/.test(q)?Number(q.replace(',','.')):NaN;
  const row={line:i,reference,sku,replacementSku,replacementQuantity:quantity};
  if(!reference||reference.length>250||!sku||sku.length>199||!replacementSku||replacementSku.length>199||sku===replacementSku||!Number.isFinite(quantity)||quantity<=0)row.error='Référence, deux SKU distincts et quantité positive requis';
  const key=JSON.stringify([reference,sku]);if(seen.has(key))row.error='Produit de cette commande répété dans le fichier';seen.add(key);rows.push(row);
 }
 if(!rows.length)throw Error('Aucune ligne de remplacement dans « Onglet type »');
 // All occurrences of a duplicate are blocked, including the first occurrence.
 const counts=new Map();for(const r of rows){const k=JSON.stringify([r.reference,r.sku]);counts.set(k,(counts.get(k)||0)+1);}
 for(const r of rows)if(counts.get(JSON.stringify([r.reference,r.sku]))>1)r.error='Produit de cette commande répété dans le fichier';
 return rows;
}
export function allocateImportStock(rows,selected=rows.map(r=>r.line)){
 const pick=new Set(selected),groups=new Map(),errors=new Map();
 for(const r of rows.filter(r=>pick.has(r.line)&&r.plan&&!r.error)){
  const item=r.plan.items.at(-1),key=JSON.stringify([item.variant.id,item.location.id]);
  if(!groups.has(key))groups.set(key,{available:Infinity,needed:0,rows:[],orders:new Set()});const g=groups.get(key);
  if(!Number.isFinite(r.plan.available)){errors.set(r.line,'Stock disponible non vérifié');continue;}
  g.available=Math.min(g.available,r.plan.available);g.needed+=r.replacementQuantity;g.rows.push(r);
  if(!g.orders.has(r.orderId)){
   g.orders.add(r.orderId);
   if(!r.plan.historicalStockProof)g.needed+=Math.max(0,r.plan.commercialBefore.line_items.filter(l=>l.type==='normal'&&String(l.variant?.id)===String(item.variant.id)&&String(l.location?.id)===String(item.location.id)).reduce((n,l)=>n+Number(l.quantity),0)-(r.plan.partialProof?.allocated?.[item.variant.id+':'+item.location.id]||0));
  }
 }
 for(const g of groups.values())if(g.needed>g.available)for(const r of g.rows)errors.set(r.line,'Stock cumulé insuffisant : '+g.needed+' unités nécessaires, '+g.available+' disponibles. Décochez des lignes puis recontrôlez.');
 return errors;
}
