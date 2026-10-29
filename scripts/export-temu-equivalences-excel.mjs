import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import ExcelJS from 'exceljs';
const require=createRequire(import.meta.url);
const analysis=require('../statut-erplain/calculateur-equivalences/temu-analysis.js');
const core=require('../statut-erplain/calculateur-equivalences/temu-equivalences.js');
const inputs=process.argv[2]||'/tmp/nextech-excel-equivalences-inputs-20261027';
const output=process.argv[3]||'Temu-product/exports/2026-10-27/Equivalences_TEMU_Erplain_actifs_sans_stock.xlsx';
const generatedAt=new Date().toISOString();
const now=process.argv[4]?Date.parse(process.argv[4]):Date.now();
if(!Number.isFinite(now))throw Error('Date de référence invalide');
const at=new Date(now).toISOString();
const stock=JSON.parse(await readFile(path.join(inputs,'stock.json'),'utf8'));
if(stock.source!=='erplain-api'||!Array.isArray(stock.items))throw Error('Stock API Erplain requis');
const goodsCategories=JSON.parse(await readFile(path.join(inputs,'categories-by-goods.json'),'utf8'));
const element={};vm.runInNewContext(await readFile('/tmp/nextech-calculateur-assets-technical-20261027/temu-catalog-data.js','utf8'),{document:{getElementById:()=>element}},{timeout:10000});
const rows=JSON.parse(element.textContent),entries=rows.map(r=>({r,e:r})),byId=new Map(rows.map(r=>[String(r.sku_id),r]));
const countries=JSON.parse(await readFile('Temu-product/exports/2026-10-27/verification.json','utf8')).countries;
await mkdir(path.dirname(output),{recursive:true});
const book=new ExcelJS.Workbook();book.creator='Nextech';book.created=new Date(generatedAt);
function sheet(name,heads){const s=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1,xSplit:4}]});s.addRow(heads);s.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};s.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173B53'}};s.getRow(1).alignment={wrapText:true,vertical:'middle'};s.getRow(1).height=42;s.columns.forEach((c,i)=>c.width=/Nom |Motif|Caractéristiques|Chemin/.test(heads[i])?65:/Catégorie|catégorie/.test(heads[i])?38:24);return s;}
const heads=['SKU TEMU','Nom produit TEMU','SKU Erplain d’origine','Nom produit Erplain d’origine','Catégorie','Sous-catégorie','Pays','Stock Erplain d’origine','Résultat recherche','Motif / caractéristiques à vérifier','SKU Erplain équivalent proposé','Nom produit Erplain équivalent proposé','Stock candidat Erplain','ID SKU TEMU','ID produit TEMU','Boutique TEMU','Chemin complet catégorie','Matière TEMU','Couleur TEMU','Dimensions TEMU','Stérilité TEMU','Volume TEMU','Taille TEMU','Calibre TEMU','Latex TEMU','Poudrage TEMU','Raccord TEMU','Usage TEMU','Couleur bouchon TEMU','Additif TEMU','Concentration TEMU','Fermeture TEMU','Vide TEMU','Caractéristiques Erplain d’origine','Caractéristiques candidat Erplain','Conditionnement TEMU à vérifier','Conditionnement candidat à vérifier','Date lecture TEMU UTC','Date stock Erplain UTC'];
const products=sheet('Actifs TEMU en rupture',heads),proposals=sheet('Équivalents proposés',heads);
const coverage=sheet('Bilan par pays',['Pays','Code pays','Date lecture TEMU UTC','Offres reçues','Lecture complète','Données TEMU récentes','Produits actifs en rupture retenus','Produits avec proposition','Lignes de propositions','État de la lecture']);
const report={at,generatedAt,historical:!!process.argv[4],stockDate:stock.date,stockReferences:stock.items.length,countries:[],products:0,proposals:0,productsWithProposals:0,missingCategories:0};
const seen=new Set();
for(const country of countries){
 let snapshot;try{snapshot=JSON.parse(await readFile(path.join(inputs,country.country+'.json'),'utf8'));}catch{}
 const fresh=snapshot?.source==='temu-api'&&snapshot.country===country.country&&now-Date.parse(snapshot.date)>=0&&now-Date.parse(snapshot.date)<=3600000;
 const info={country:country.country,name:country.name,date:snapshot?.date||'',offers:(snapshot?.shops||[]).reduce((n,s)=>n+(s.offers?.length||0),0),complete:snapshot?.complete===true,fresh,products:0,productsWithProposals:0,proposals:0};
 if(fresh){
  const built=analysis.build({country:country.country,snapshot,items:stock.items,entries,core,now});
  const eligible=analysis.filter(built.rows,{action:['zero'],status:['actif'],stock:['no']});
  const groups=new Map();for(const c of built.candidates){if(!groups.has(c.profile.type))groups.set(c.profile.type,[]);groups.get(c.profile.type).push(c);}
  for(const x of eligible){
   if(seen.has(x.key))throw Error('Offre exportée plusieurs fois');seen.add(x.key);
   if(x.status!=='actif'||x.stockState!=='no'||!Number.isFinite(x.stock.quantity)||x.stock.quantity>0||x.profile.technical.excluded)throw Error('Produit hors périmètre');
   const result=analysis.propose(x,groups.get(x.profile.type)||[]),meta=byId.get(x.entryId),full=goodsCategories[country.country]?.[String(x.offer.goodsId)]||meta?.temu_category||'',parts=full.split(/\s*\/\s*/).filter(Boolean),f=x.profile.features;
   if(!full)report.missingCategories++;
   info.products++;report.products++;
   if(result.items.length){info.productsWithProposals++;report.productsWithProposals++;}
   const origin=analysis.technical.extract(x.stock).features;
   for(const candidate of result.items.length?result.items:[null]){
    const values=[String(x.offer.sellerSku||''),x.offer.product,String(x.sku),x.stock.product,parts[0]||'Non renseignée par TEMU',parts[1]||'',country.country,x.stock.quantity,candidate?'Proposition à valider':'Aucune proposition retenue',candidate?candidate.note:result.reason,candidate?String(candidate.stock.sku):'',candidate?.profile.name||'',candidate?.stock.quantity??null,String(x.offer.id),String(x.offer.goodsId||''),String(x.shop),full,f.matiere||'',f.couleur||'',f.dimensions||'',f.sterilite||'',f.volume||'',f.taille||'',f.calibre||'',f.latex||'',f.poudre||'',f.raccord||'',f.usage||'',f.couleurBouchon||'',f.additif||'',f.concentration||'',f.fermeture||'',f.vide||'',Object.entries(origin).map(([k,v])=>(analysis.technical.fieldNames[k]||k)+' : '+v).join(' | '),candidate?Object.entries(candidate.profile.features).map(([k,v])=>(analysis.technical.fieldNames[k]||k)+' : '+v).join(' | '):'',x.profile.pack??'',candidate?.profile.pack??'',snapshot.date,stock.date];
    products.addRow(values);if(candidate){proposals.addRow(values);info.proposals++;report.proposals++;}
   }
  }
 }
 info.status=fresh?(info.complete?'Lecture complète disponible':'Lecture partielle : couverture non garantie'):info.offers?'Lecture trop ancienne : pays non inclus':'Lecture en cours ou indisponible : pays non inclus';
 report.countries.push(info);coverage.addRow([info.name,info.country,info.date,info.offers,info.complete?'Oui':'Non',info.fresh?'Oui':'Non',info.products,info.productsWithProposals,info.proposals,info.status]);
 console.log('COUNTRY',info.country,info.products,info.proposals,info.status);
}
const notes=sheet('À lire',['Information','Détail']);notes.getColumn(1).width=35;notes.getColumn(2).width=140;
for(const pair of [
 ['Génération du fichier UTC',generatedAt],['Date de référence UTC',at],['Actualité des données',process.argv[4]?'Analyse historique des données conservées du 27/10/2026. Le stock et les statuts ne sont pas vérifiés à la date de génération.':'Analyse à la date de génération'],['Périmètre','Offres TEMU actives dans le pays consulté, avec une référence Erplain identifiée et un stock disponible connu inférieur ou égal à zéro. Incontinence exclue.'],['Premiers SKU Erplain','Les colonnes « d’origine » identifient la référence Erplain actuellement reliée à l’offre et en rupture. Ce ne sont pas des équivalents disponibles.'],['Équivalents proposés','Les colonnes de candidat sont remplies uniquement si le moteur trouve un produit en stock qui passe ses critères stricts. Une cellule vide ne signifie pas qu’aucun équivalent n’existe dans tout Erplain.'],['Validation','Les propositions restent à vérifier techniquement et à valider pour le conditionnement, le coût et la quantité par lot. Aucun remplacement ni modification dans TEMU ou Erplain.'],['Caractéristiques inconnues','Les valeurs manquantes restent vides. Elles ne sont jamais supposées identiques. Les noms et caractéristiques sont ceux disponibles dans les données lues.'],['Couverture pays','Le bilan indique les pays inclus et ceux dont la lecture est absente, trop ancienne (plus d’une heure) ou en cours. Les lectures partielles ne garantissent pas l’exhaustivité.'],['Catégories','Chemins TEMU issus de l’export API du 27/10/2026 et du catalogue publié ; la langue d’origine est conservée. Une catégorie non disponible reste explicitement non renseignée.'],['Correspondances','SKU exact ou correspondance du catalogue publié du calculateur. Les corrections locales de votre navigateur ne sont pas accessibles depuis cette extraction. Le service de catalogue partagé était indisponible (HTTP 503).'],['Source stock','API Erplain, '+stock.date+' ; '+stock.items.length+' références actives chargées.'],['Stock partagé','Plusieurs offres peuvent utiliser le même SKU Erplain ; les quantités de stock ne doivent pas être additionnées entre ces lignes.'],['Tubes','Matière, dimensions, volume, stérilité, usage, couleur du bouchon, additif, fermeture et vide requis. Concentration obligatoire pour citrate/héparine ; EDTA sans sous-type K2/K3 bloqué.'],['Types non couverts','Le moteur ne propose pas de remplacement pour un type sans règle technique complète. L’exclusion préexistante des pansements est conservée.'],['Produits actifs en rupture',report.products],['Produits avec proposition',report.productsWithProposals],['Lignes de propositions',report.proposals],['Catégories non renseignées',report.missingCategories]
])notes.addRow(pair);
for(const s of [products,proposals,coverage])s.autoFilter={from:{row:1,column:1},to:{row:s.rowCount,column:s.columnCount}};
await book.xlsx.writeFile(output);await writeFile(output.replace(/\.xlsx$/i,'.json'),JSON.stringify(report,null,2));console.log('EXCEL_READY',output,JSON.stringify({products:report.products,productsWithProposals:report.productsWithProposals,proposals:report.proposals,countries:report.countries.filter(c=>c.fresh).map(c=>c.country)}));
