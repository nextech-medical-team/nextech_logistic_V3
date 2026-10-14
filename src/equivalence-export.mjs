import ExcelJS from 'exceljs';
import {importHeaders} from './equivalence-import-file.mjs';
import {readEquivalentProduct} from './equivalence-catalog.mjs';
import {stockChoiceLocation} from './stock-choice-location.mjs';
import {suspensionBlock} from './order-suspension.mjs';

const numeric=v=>(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
export function shortageRows(order){
 if(!Array.isArray(order?.line_items))throw Error('Lignes du BC non vérifiables');
 const groups=new Map();
 for(const l of order.line_items){
  if(l.type!=='normal'||!l.variant||l.variant.track_inventory===false)continue;
  if(l.variant.track_inventory!==true||!l.variant.sku||!l.location?.id||![l.quantity,l.available,l.on_hand,l.reserved_quantity].every(numeric)||Number(l.quantity)<=0)throw Error('Stock ou quantité non vérifiable');
  const key=JSON.stringify([l.variant.id,l.location.id]);
  const g=groups.get(key)||{sku:l.variant.sku,quantity:0,reserved:0,available:Number(l.available),onHand:Number(l.on_hand)};
  g.quantity+=Number(l.quantity);g.reserved+=Math.max(0,Number(l.reserved_quantity));g.available=Math.min(g.available,Number(l.available));g.onHand=Math.min(g.onHand,Number(l.on_hand));groups.set(key,g);
 }
 const rows=new Map();
 for(const g of groups.values()){
  const usable=Math.max(0,Math.min(g.onHand,g.available+g.reserved));
  if(usable+1e-6>=g.quantity)continue;
  const quantity=order.line_items.filter(l=>l.type==='normal'&&l.variant?.sku===g.sku).reduce((n,l)=>n+Number(l.quantity),0);
  if(!Number.isFinite(quantity)||quantity<=0)throw Error('Quantité de remplacement non vérifiable');
  rows.set(g.sku,{sku:g.sku,quantity});
 }
 return [...rows.values()];
}
export async function readExportOrders(api,orders){
 const fields='id status line_items{type quantity available on_hand reserved_quantity location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}';
 const query='query V3EquivalenceExportBatch('+orders.map((_,i)=>'$b'+i+':ID!').join(',')+'){'+orders.map((_,i)=>`o${i}:Order(id:$b${i}){${fields}}`).join(' ')+'}';
 const result=await api.request(query,Object.fromEntries(orders.map((o,i)=>['b'+i,String(o.erp_live.bc.id)])),0,true);
 return orders.map((_,i)=>({bc:result?.['o'+i],error:result?._v3Errors?.some(e=>!e.path?.length||e.path[0]==='o'+i)?'Réponse Erplain partielle : BC non vérifié':null}));
}
export async function exportEquivalences(db,api,directory,{template=false,onProgress=()=>{},scope=null}={}){
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Onglet type');
 sheet.addRow(importHeaders);sheet.columns=importHeaders.map((h,i)=>({width:i===0?38:28,style:{numFmt:i<3?'@':'0.######'}}));sheet.views=[{state:'frozen',ySplit:1}];
 const suggestions=book.addWorksheet('Équivalents proposés');
 suggestions.addRow(['Numéro de commande','SKU de base','Quantité entière à remplacer','SKU équivalent enregistré','Stock disponible','Commentaire / contrôle','Vérifié le (UTC)']);
 suggestions.columns=[38,28,28,30,22,65,30].map(width=>({width}));
 const controls=book.addWorksheet('Contrôles');controls.addRow(['Commande','Résultat']);controls.columns=[{width:38},{width:100}];
 controls.addRow(['Mode d’emploi','Choisir le SKU de remplacement dans Onglet type, conserver les identifiants au format texte, puis analyser le fichier dans V3. Les propositions sont réciproques et actives uniquement. Une unité remplace une unité.']);
 controls.addRow(['Validation','Les stocks sont indicatifs à la date de lecture. L’analyse puis l’application recontrôlent les commandes et le stock cumulé. Aucun remplacement automatique.']);
 let count=0,unverified=0;
 if(!template){
  const orders=scope?.rows||(await db.query(`SELECT * FROM orders WHERE channel=ANY($1::text[]) AND NOT archived AND NOT simulation AND coalesce(tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated') AND coalesce(label_status,'')<>'cancelled' ORDER BY reference,id`,[['amazon','shopify','temu']])).rows;
  if(scope&&orders.length!==scope.total)throw Error('Périmètre incomplet : nombre de commandes différent du filtre. Export refusé.');
  if(new Set(orders.map(o=>o.id||o.reference)).size!==orders.length)throw Error('Périmètre ambigu : commande répétée. Export refusé.');
  const coverage=book.addWorksheet('Commandes du filtre');coverage.addRow(['Numéro de commande','Canal','Diagnostic affiché dans V3','Résultat du contrôle','Lignes dans Onglet type']);coverage.columns=[38,18,85,85,25].map(width=>({width}));const scopeRows=new Map();
  for(const o of orders){const row=coverage.addRow([o.reference,o.channel||'',o.stockDiagnostics?.map(d=>d.detail||d.label).join(' ; ')||o.issue||'Diagnostic stock du filtre','Vérification en attente',0]);scopeRows.set(o,row);}
  const diagnosticRows=new Map();
  const mark=(o,reason,lines=0)=>{const row=scopeRows.get(o);row.getCell(4).value=reason;row.getCell(5).value=lines;for(const d of diagnosticRows.get(o)||[])d.getCell(6).value=reason;};
  const deferredSuggestions=[];
  const defer=(o,reason)=>{const diagnostics=(o.stockDiagnostics||[]).filter(d=>d.sku);if(diagnostics.length)for(const d of diagnostics)deferredSuggestions.push({o,sku:d.sku,reason});else if(scope)suggestions.addRow([o.reference,'','','','','SKU du diagnostic à identifier · '+reason,new Date().toISOString()]);};
  const pairs=(await db.query('SELECT sku_a,sku_b,notes FROM product_equivalences WHERE active ORDER BY sku_a,sku_b')).rows;
  if(scope){
   const diagnostics=book.addWorksheet('Diagnostics stock');diagnostics.addRow(['Numéro de commande','SKU du diagnostic','Diagnostic affiché dans V3','Quantité V3 indicative','Équivalents actifs enregistrés','Résultat du contrôle actuel']);diagnostics.columns=[38,28,85,25,55,85].map(width=>({width}));
   for(const o of orders){const entries=[];for(const d of o.stockDiagnostics||[]){const matching=(o.sku_lines||[]).filter(l=>l.sku===d.sku),quantity=matching.length&&matching.every(l=>numeric(l.quantity))?matching.reduce((n,l)=>n+Number(l.quantity),0):'';const alternatives=pairs.filter(p=>p.sku_a===d.sku||p.sku_b===d.sku).map(p=>p.sku_a===d.sku?p.sku_b:p.sku_a);entries.push(diagnostics.addRow([o.reference,d.sku||'',d.detail||d.label,quantity,alternatives.join(' ; ')||'Aucun équivalent actif enregistré','Vérification en attente']));}diagnosticRows.set(o,entries);}
  }
  const locationId=await stockChoiceLocation(directory),cache=new Map();let processed=0;
  const progress=phase=>onProgress({phase,total:orders.length,processed,rows:count,unverified});
  progress('identity');await api.verify();const pending=[];
  for(const o of orders){
   const blocked=suspensionBlock(o);
   const exclusion=blocked||(!['amazon','shopify','temu'].includes(o.channel)&&o.channel?'Canal non pris en charge par l’import des équivalences : parcours dédié requis':null)||(['cancelled','shipped','delivered','in_transit','delivered_simulated'].includes(o.tracking_status)?'Commande expédiée, livrée ou annulée : contrôle par le parcours dédié':null)||(o.partial_mode||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id?'Livraison existante ou partielle : traitement par le parcours dédié':null);
   if(exclusion){controls.addRow([o.reference,exclusion]);mark(o,exclusion);defer(o,exclusion);processed++;continue;}
   if(!o.erp_live?.bc?.id){const reason='BC absent : rupture non vérifiable';controls.addRow([o.reference,reason]);mark(o,reason);defer(o,reason);unverified++;processed++;continue;}
   pending.push(o);
  }
  // Ten BCs share one quota slot; calls remain sequential and retain the shared limiter.
  for(let offset=0;offset<pending.length;offset+=10){
   const batch=pending.slice(offset,offset+10);progress('orders');let snapshots;
   try{snapshots=await readExportOrders(api,batch);}catch(e){for(const o of batch){const reason='Non vérifié : '+e.message;controls.addRow([o.reference,reason]);mark(o,reason);defer(o,reason);unverified++;processed++;}progress('orders');continue;}
   for(let index=0;index<batch.length;index++){
   const o=batch[index];
   let missing;
   try{
    if(snapshots[index].error)throw Error(snapshots[index].error);
    const bc=snapshots[index].bc;
    if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length)throw Error('BC ou livraisons à rapprocher');
    missing=shortageRows(bc);
   }catch(e){const reason='Non vérifié : '+e.message;controls.addRow([o.reference,reason]);mark(o,reason);defer(o,reason);unverified++;processed++;progress('orders');continue;}
   mark(o,missing.length?'Rupture confirmée dans le BC actuel · choix à compléter avant analyse':'Stock suffisant au contrôle actuel · diagnostic V3 conservé pour rapprochement',missing.length);
   for(const r of missing){
    if(++count>1000)throw Error('Plus de 1 000 lignes en rupture : export interrompu sans troncature. Le format d’import est limité à 1 000 lignes.');
    sheet.addRow([o.reference,r.sku,'',r.quantity]);
    const alternatives=pairs.filter(p=>p.sku_a===r.sku||p.sku_b===r.sku);
    if(!alternatives.length)suggestions.addRow([o.reference,r.sku,r.quantity,'','','Aucun équivalent actif enregistré',new Date().toISOString()]);
    for(const p of alternatives){
     const sku=p.sku_a===r.sku?p.sku_b:p.sku_a;
     if(!cache.has(sku)){
      progress('alternatives');
      try{const product=await readEquivalentProduct(api,sku,{locationId});cache.set(sku,{...product,at:new Date().toISOString()});}
      catch(e){cache.set(sku,{stockError:e.message,at:new Date().toISOString()});}
     }
     const product=cache.get(sku),status=product.stockError||(!product.stockTracked?'Stock non suivi':product.available>=r.quantity?'Stock suffisant pour cette ligne uniquement':'Stock insuffisant');
     suggestions.addRow([o.reference,r.sku,r.quantity,sku,product.available??'', [status,p.notes].filter(Boolean).join(' · '),product.at]);
    }
   }
   processed++;progress('orders');
   }
  }
  // Suggestions remain visible for excluded business paths, without creating import rows.
  const deferredSeen=new Set();
  for(const {o,sku,reason} of deferredSuggestions){
   const key=JSON.stringify([o.id||o.reference,sku]);if(deferredSeen.has(key))continue;deferredSeen.add(key);
   const alternatives=pairs.filter(p=>p.sku_a===sku||p.sku_b===sku);
   if(!alternatives.length)suggestions.addRow([o.reference,sku,'','','','Aucun équivalent actif enregistré · '+reason,new Date().toISOString()]);
   for(const p of alternatives){const alternative=p.sku_a===sku?p.sku_b:p.sku_a;suggestions.addRow([o.reference,sku,'',alternative,'','Équivalence enregistrée · stock et quantité à vérifier par le parcours dédié · '+reason,new Date().toISOString()]);}
  }
  progress('workbook');
  controls.addRow(['Couverture',`${orders.length} commandes examinées ; ${count} lignes en rupture vérifiées ; ${unverified} commandes non vérifiables. Consulter toutes les exclusions ci-dessus.`]);
  if(scope)controls.addRow(['Périmètre V3',`${scope.total} commandes du filtre stock ; ${scope.summary?.blocked??'Non fourni'} « À compléter ». Toutes figurent dans Commandes du filtre. Onglet type contient uniquement les lignes vérifiées pour le parcours d’import standard.`]);
 }
 for(const s of book.worksheets){
  s.views=[{state:'frozen',ySplit:1}];s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF146E5B'}};
  s.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};let lines=1;row.eachCell((cell,col)=>{lines=Math.max(lines,Math.ceil(String(cell.value??'').length/Math.max(10,(s.getColumn(col).width||28)-4)));});row.height=Math.max(row.number===1?36:24,Math.min(400,lines*16+8));});
 }
 return {filename:template?'Modele_import_equivalences.xlsx':'Ruptures_equivalences.xlsx',file:Buffer.from(await book.xlsx.writeBuffer()).toString('base64'),rows:count,unverified,...(scope?{scopeTotal:scope.total,scopeBlocked:scope.summary?.blocked}: {})};
}
