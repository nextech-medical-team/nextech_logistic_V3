import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {categoryParts,csvCell} from './export-temu-catalogue.mjs';

const labels={FR:'France',DE:'Allemagne',ES:'Espagne',IT:'Italie',NL:'Pays-Bas',PT:'Portugal',PL:'Pologne',SE:'Suède',GR:'Grèce',IE:'Irlande',CZ:'Tchéquie',HU:'Hongrie',DK:'Danemark',BE:'Belgique',SK:'Slovaquie',HR:'Croatie',SI:'Slovénie',LV:'Lettonie'};
const statusLabels={1:'Publié / dépublié',4:'Non publié',5:'Brouillon',6:'Supprimé'};
const headers=['Pays','Code pays','Boutique','ID produit','Produit','Catégorie','Sous-catégorie','Chemin complet','ID catégorie','Statuts de recherche','Statut TEMU','Sous-statut TEMU','SKU externes','IDs SKU','Prix TEMU','Devise','Quantité TEMU','Image'];
function addHeader(sheet,values){const r=sheet.addRow(values);r.font={bold:true,color:{argb:'FFFFFFFF'}};r.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF203E52'}};r.commit();}
export async function finalize(directory,excelModule='/opt/nextech/current/node_modules/exceljs/excel.js'){
 const report=JSON.parse(await readFile(path.join(directory,'bilan.json'),'utf8'));if(!report.finishedAt)throw Error('Extraction encore en cours');
 const {default:ExcelJS}=await import(pathToFileURL(excelModule).href);
 const workbook=new ExcelJS.stream.xlsx.WorkbookWriter({filename:path.join(directory,'Catalogue-TEMU-tous-pays.xlsx'),useStyles:true,useSharedStrings:false});
 const summary=workbook.addWorksheet('Bilan',{views:[{state:'frozen',ySplit:1}]});summary.columns=[{width:24},{width:14},{width:20},{width:18},{width:18},{width:20},{width:28},{width:65}];
 const summaryHeaders=['Pays','Code','Boutique','Produits exportés','Sans intitulé catégorie','Publiés/dépubliés','Tous les statuts quantifiés','Observations'];addHeader(summary,summaryHeaders);
 const categorySheet=workbook.addWorksheet('Catégories',{views:[{state:'frozen',ySplit:1}]});categorySheet.columns=[{width:22},{width:14},{width:45},{width:45},{width:100},{width:18}];addHeader(categorySheet,['Pays','Code','Catégorie','Sous-catégorie','Chemin complet','Produits']);
 const missing=[],coverage=[],tree={};
 const accounts=report.accounts.filter(a=>a.mallId&&!a.duplicate).sort((a,b)=>a.country.localeCompare(b.country));
 for(const account of accounts){
  const folder=path.join(directory,account.country+'-'+account.mallId);let products;
  try{products=(await readFile(path.join(folder,'produits.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT'){coverage.push({country:account.country,products:0,errors:[account.error||'Fichier absent']});continue;}throw e;}
  const ids=new Set(products.map(g=>String(g.goodsId)));if(ids.size!==products.length)throw Error('Doublons dans '+account.country);
  if(products.length!==account.products)throw Error('Nombre de produits incohérent pour '+account.country);
  const listed=account.statuses.find(s=>s.searchType===1);const quantified=account.statuses.every(s=>s.status==='complete');
  const notes=account.statuses.filter(s=>s.status!=='complete').map(s=>(statusLabels[s.searchType]||s.searchType)+' : '+(s.error||s.status));
  const countryName=labels[account.country]||account.country;const sheet=workbook.addWorksheet(account.country+' - '+countryName,{views:[{state:'frozen',ySplit:1}]});
  sheet.columns=headers.map((_,i)=>({width:i===4?65:i===7?100:i===5||i===6?40:i===17?30:20}));addHeader(sheet,headers);
  const groups=new Map();tree[account.country]={name:countryName,categories:{}};
  for(const g of products){
   const parts=categoryParts(g.categoryPath),category=parts[0]||'À classer',subcategory=parts[1]||'';
   const values=[countryName,account.country,account.mallId,String(g.goodsId),g.goodsName,category,subcategory,parts.join(' / '),String(g.catId??''),(g.searchTypes||[]).map(s=>statusLabels[s]||s).join(' | '),g.status4VO,g.subStatus4VO,(g.outSkuSnList||[]).join(' | '),(g.skuIdList||[]).map(String).join(' | '),g.price,g.currency,g.quantity,g.thumbUrl];sheet.addRow(values).commit();
   const group=parts.join(' / ')||'À classer';groups.set(group,(groups.get(group)||0)+1);
   const root=tree[account.country].categories;root[category]??={count:0,subcategories:{}};root[category].count++;root[category].subcategories[subcategory||'(sans sous-catégorie)']??={count:0,paths:{}};const sub=root[category].subcategories[subcategory||'(sans sous-catégorie)'];sub.count++;sub.paths[group]=(sub.paths[group]||0)+1;
   if(!parts.length)missing.push([countryName,account.country,String(g.goodsId),g.goodsName,String(g.catId??'')]);
  }
  for(const [full,count] of groups){const p=categoryParts(full);categorySheet.addRow([countryName,account.country,p[0],p[1]||'',full,count]).commit();}
  sheet.autoFilter={from:'A1',to:{row:products.length+1,column:headers.length}};sheet.commit();
  summary.addRow([countryName,account.country,account.mallId,products.length,account.unclassified,listed?.status==='complete'?'Complet':'À vérifier',quantified?'Oui':'Réponse partielle',notes.join(' ; ')]).commit();
  coverage.push({country:account.country,name:countryName,products:products.length,unclassified:account.unclassified,publishedComplete:listed?.status==='complete',allStatusesQuantified:quantified,notes});
 }
 const requested=new Set(coverage.map(c=>c.country));for(const country of report.requestedCountries)if(!requested.has(country)){summary.addRow([labels[country]||country,country,'',0,0,'Accès indisponible','Non',report.accounts.filter(a=>a.country===country&&a.error).map(a=>a.error).join('; ')]).commit();}
 summary.autoFilter={from:'A1',to:{row:coverage.length+1,column:summaryHeaders.length}};summary.commit();categorySheet.commit();
 const info=workbook.addWorksheet('À lire');info.columns=[{width:35},{width:130}];addHeader(info,['Information','Détail']);for(const pair of [
  ['Extraction',report.startedAt+' → '+report.finishedAt],['Périmètre','Boutiques TEMU configurées sur le serveur ; tous les pays configurés, sans modification des boutiques.'],['Classement','Pays → catégorie → sous-catégorie → chemin complet. Les intitulés fournis par TEMU sont conservés dans leur langue source.'],['Statuts','Les produits publiés/dépubliés, non publiés, brouillons et supprimés sont exportés séparément puis dédupliqués par pays et ID produit.'],['Couverture','Le bilan distingue les listes complètes des réponses vides ou des erreurs. Une réponse vide aux brouillons ne prouve pas un total nul.'],['Catégories manquantes','Les produits dont TEMU ne fournit pas le nom de catégorie sont conservés dans « À classer ». Leur ID catégorie reste disponible.'],['Prix et stocks','Valeurs retournées par la liste TEMU, sans conversion ni modification. Les champs détaillés de chaque variante ne sont pas systématiquement présents dans cette liste.'],['Identifiants','Les IDs produit, boutique et SKU sont enregistrés comme du texte pour conserver leurs chiffres.'],['Doublons entre pays','Un même produit vendu dans plusieurs pays reste présent dans chacun de ces pays.']])info.addRow(pair).commit();info.commit();await workbook.commit();
 await writeFile(path.join(directory,'categories-par-pays.json'),JSON.stringify(tree,null,2),{mode:0o600});
 const missingHeaders=['Pays','Code pays','ID produit','Produit','ID catégorie TEMU'];await writeFile(path.join(directory,'produits-a-classer.csv'),'\uFEFF'+[missingHeaders,...missing].map(r=>r.map(csvCell).join(';')).join('\r\n')+'\r\n',{mode:0o600});
 const verification={generatedAt:new Date().toISOString(),countries:coverage,totalProducts:coverage.reduce((n,c)=>n+c.products,0),unclassified:missing.length,publishedComplete:coverage.length===report.requestedCountries.length&&coverage.every(c=>c.publishedComplete),allStatusesQuantified:coverage.every(c=>c.allStatusesQuantified)};
 await writeFile(path.join(directory,'verification.json'),JSON.stringify(verification,null,2),{mode:0o600});console.log(JSON.stringify(verification));return verification;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)finalize(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1;});
