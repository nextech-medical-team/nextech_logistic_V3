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
export async function exportEquivalences(db,api,directory,{template=false}={}){
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
  const orders=(await db.query(`SELECT * FROM orders WHERE channel=ANY($1::text[]) AND NOT archived AND NOT simulation AND coalesce(tracking_status,'') NOT IN ('cancelled','shipped','delivered','in_transit','delivered_simulated') AND coalesce(label_status,'')<>'cancelled' ORDER BY reference,id`,[['amazon','shopify','temu']])).rows;
  const pairs=(await db.query('SELECT sku_a,sku_b,notes FROM product_equivalences WHERE active ORDER BY sku_a,sku_b')).rows;
  const locationId=await stockChoiceLocation(directory),cache=new Map();await api.verify();
  for(const o of orders){
   const blocked=suspensionBlock(o);
   if(blocked||o.partial_mode||o.erp_live?.bl?.id||o.erp_live?.stockDocument?.id){controls.addRow([o.reference,blocked||'Livraison existante ou partielle : traitement par le parcours dédié']);continue;}
   if(!o.erp_live?.bc?.id){controls.addRow([o.reference,'BC absent : rupture non vérifiable']);unverified++;continue;}
   let missing;
   try{
    const response=await api.request('query V3EquivalenceExport($id:ID!){Order(id:$id){id status line_items{type quantity available on_hand reserved_quantity location{id} variant{id sku track_inventory}} shipping_orders(first:100){data{id} paginatorInfo{hasMorePages}}}}',{id:String(o.erp_live.bc.id)});
    const bc=response.Order;
    if(String(bc?.id)!==String(o.erp_live.bc.id)||bc.status!=='active'||!Array.isArray(bc.shipping_orders?.data)||bc.shipping_orders.paginatorInfo?.hasMorePages!==false||bc.shipping_orders.data.length)throw Error('BC ou livraisons à rapprocher');
    missing=shortageRows(bc);
   }catch(e){controls.addRow([o.reference,'Non vérifié : '+e.message]);unverified++;continue;}
   for(const r of missing){
    if(++count>1000)throw Error('Plus de 1 000 lignes en rupture : export interrompu sans troncature. Le format d’import est limité à 1 000 lignes.');
    sheet.addRow([o.reference,r.sku,'',r.quantity]);
    const alternatives=pairs.filter(p=>p.sku_a===r.sku||p.sku_b===r.sku);
    if(!alternatives.length)suggestions.addRow([o.reference,r.sku,r.quantity,'','','Aucun équivalent actif enregistré',new Date().toISOString()]);
    for(const p of alternatives){
     const sku=p.sku_a===r.sku?p.sku_b:p.sku_a;
     if(!cache.has(sku)){
      try{const product=await readEquivalentProduct(api,sku,{locationId});cache.set(sku,{...product,at:new Date().toISOString()});}
      catch(e){cache.set(sku,{stockError:e.message,at:new Date().toISOString()});}
     }
     const product=cache.get(sku),status=product.stockError||(!product.stockTracked?'Stock non suivi':product.available>=r.quantity?'Stock suffisant pour cette ligne uniquement':'Stock insuffisant');
     suggestions.addRow([o.reference,r.sku,r.quantity,sku,product.available??'', [status,p.notes].filter(Boolean).join(' · '),product.at]);
    }
   }
  }
  controls.addRow(['Couverture',`${orders.length} commandes examinées ; ${count} lignes en rupture vérifiées ; ${unverified} commandes non vérifiables. Consulter toutes les exclusions ci-dessus.`]);
 }
 for(const s of book.worksheets){s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF146E5B'}};s.getRow(1).height=32;s.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});}
 return {filename:template?'Modele_import_equivalences.xlsx':'Ruptures_equivalences.xlsx',file:Buffer.from(await book.xlsx.writeBuffer()).toString('base64'),rows:count,unverified};
}
