import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';

const API='https://openapi-b-eu.temu.com/openapi/router';
const allowed=new Set(['bg.open.accesstoken.info.get','bg.local.goods.list.query','bg.local.goods.detail.query']);
export function csvCell(value){let s=value==null?'':String(value);if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function categoryParts(name){return typeof name==='string'?name.split(/\s+\/\s+/).map(x=>x.trim()).filter(Boolean):[];}
export function collectProducts(pages){const rows=new Map();for(const p of pages){if(!Array.isArray(p.goodsList))throw Error('Liste produits absente');for(const g of p.goodsList){if(!g.goodsId)throw Error('Identifiant produit absent');rows.set(String(g.goodsId),g);}}return [...rows.values()];}

async function json(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
const saves=new Map();
async function save(file,data){const contents=JSON.stringify(data,null,2);const pending=(saves.get(file)||Promise.resolve()).then(async()=>{await writeFile(file+'.tmp',contents,{mode:0o600});await rename(file+'.tmp',file);});saves.set(file,pending.catch(()=>{}));await pending;}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function client(config){let previous=0;return async(type,args={})=>{
 if(!allowed.has(type))throw Error('Opération interdite : export en lecture seule');
 for(let attempt=0;attempt<4;attempt++){
  await pause(Math.max(0,previous+650-Date.now()));previous=Date.now();
  const p={app_key:config.TEMU_APP_KEY,access_token:config.TEMU_ACCESS_TOKEN,data_type:'JSON',timestamp:String(Math.floor(Date.now()/1000)),type,...args};
  const joined=Object.keys(p).sort().map(k=>k+(typeof p[k]==='object'?JSON.stringify(p[k]):String(p[k]))).join('');
  p.sign=createHash('md5').update(config.TEMU_APP_SECRET+joined+config.TEMU_APP_SECRET).digest('hex').toUpperCase();
  try{const response=await fetch(API,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const body=await response.json();
   if(!body.success||![0,1000000].includes(Number(body.errorCode??0)))throw Error('TEMU '+body.errorCode+' '+String(body.errorMsg||'').slice(0,200));
   if(body.result==null)throw Error('Résultat TEMU vide');return body.result;
  }catch(e){if(attempt===3)throw e;await pause(2000*(attempt+1));}
 }
};}
export {client as readOnlyClient};
const columns=['Pays','Boutique','ID produit','Nom produit','Catégorie','Sous-catégorie','Chemin catégorie complet','ID catégorie','Statuts de recherche','Statut TEMU','Sous-statut TEMU','SKU externes','IDs SKU','Prix retourné TEMU','Devise','Quantité retournée TEMU','Image'];
function row(country,mallId,g,categories,statuses){const parts=categoryParts(categories[String(g.catId)]?.name);return [country,String(mallId),String(g.goodsId),g.goodsName,parts[0]||'À classer',parts[1]||'',parts.join(' / '),String(g.catId??''),(statuses[String(g.goodsId)]||[]).join(','),g.status4VO,g.subStatus4VO,(g.outSkuSnList||[]).join(' | '),(g.skuIdList||[]).map(String).join(' | '),g.price,g.currency,g.quantity,g.thumbUrl];}
async function csv(file,rows){const stream=createWriteStream(file,{encoding:'utf8',mode:0o600});stream.write('\uFEFF');for(const values of [columns,...rows])if(!stream.write(values.map(csvCell).join(';')+'\r\n'))await once(stream,'drain');await new Promise((resolve,reject)=>{stream.once('error',reject);stream.end(resolve);});}

export async function run({output,configFile='/var/lib/nextech-live/temu-production.json',vaultFile='/etc/nextech/temu-shops.json',excelModule='/opt/nextech/current/node_modules/exceljs/excel.js'}={}){
 if(!output)throw Error('Dossier de sortie requis');await mkdir(output,{recursive:true,mode:0o700});
 const main=await json(configFile),vault=await json(vaultFile,[]);
 const configs=[{country:'FR',config:main},...vault.map(m=>({country:String(m.country).toUpperCase(),config:{TEMU_APP_KEY:m.appKey,TEMU_APP_SECRET:m.appSecret,TEMU_ACCESS_TOKEN:m.accessToken}}))];
 const report={startedAt:new Date().toISOString(),readOnly:true,endpoint:API,requestedCountries:[...new Set(configs.map(x=>x.country))],accounts:[],notes:['Les statuts de recherche 1, 4, 5 et 6 sont interrogés séparément.','Les intitulés de catégories proviennent de détails produits TEMU, sans traduction inventée.','Les prix et quantités sont ceux retournés par la liste TEMU ; aucun stock ni prix ne sont modifiés.']};
 await save(path.join(output,'bilan.json'),report);
 const seen=new Set(),results=[],sharedCategories={};
 // Identify accounts before exporting; repeated credentials for the same mall do not duplicate the catalogue.
 for(const entry of configs){const read=client(entry.config);try{const identity=await read('bg.open.accesstoken.info.get');if(!identity.mallId)throw Error('Identité boutique absente');
  const key=entry.country+'-'+identity.mallId;if(seen.has(key)){report.accounts.push({country:entry.country,mallId:String(identity.mallId),duplicate:true});continue;}seen.add(key);
  const account={country:entry.country,mallId:String(identity.mallId),status:'pending',statuses:[],categoryErrors:[]};report.accounts.push(account);results.push({entry,read,account,key});
  console.log('IDENTITY',entry.country,String(identity.mallId));
 }catch(e){report.accounts.push({country:entry.country,status:'connection_error',error:e.message});console.log('IDENTITY_ERROR',entry.country,e.message);}await save(path.join(output,'bilan.json'),report);}
 for(const {key} of results)Object.assign(sharedCategories,await json(path.join(output,key,'categories.json'),{}));
 async function exportAccount({entry,read,account,key}){
  const folder=path.join(output,key);await mkdir(folder,{recursive:true,mode:0o700});account.status='running';
  const all=[],statuses={};
  for(const status of [1,4,5,6]){const summary={searchType:status,status:'running',pages:0,expected:0,unique:0};account.statuses.push(summary);const pages=[];
   try{let expected;for(let page=1;page<=10000;page++){
    const filename=path.join(folder,`status-${status}-page-${page}.json`);let data=await json(filename);
    if(!data){data=await read('bg.local.goods.list.query',{pageNo:page,pageSize:100,goodsSearchType:status,orderField:'goodsId',orderType:1});if(data.goodsList==null&&Number(data.total)===0)data.goodsList=[];if(!Array.isArray(data.goodsList))throw Error('goodsList absente');await save(filename,data);}
    if(!Array.isArray(data.goodsList)||!Number.isFinite(Number(data.total)))throw Error('Pagination TEMU invalide');
    if(expected===undefined)expected=Number(data.total);summary.expected=expected;summary.latestTotal=Number(data.total);pages.push(data);summary.pages=page;
    if(page%20===0)console.log('PAGES',entry.country,status,page,expected);
    if(!data.goodsList.length||page*100>=Number(data.total)||page===100)break;
    if(page===10000)throw Error('Limite de pagination atteinte');
   }
   // TEMU refuses page 101. Read from the other end and deduplicate the overlapping windows.
   if(collectProducts(pages).length<summary.latestTotal){summary.reversePages=0;for(let page=1;page<=100;page++){
    const filename=path.join(folder,`status-${status}-reverse-page-${page}.json`);let data=await json(filename);
    if(!data){data=await read('bg.local.goods.list.query',{pageNo:page,pageSize:100,goodsSearchType:status,orderField:'goodsId',orderType:0});if(!Array.isArray(data.goodsList))throw Error('goodsList inverse absente');await save(filename,data);}
    pages.push(data);summary.reversePages=page;summary.latestTotal=Number(data.total);
    if(collectProducts(pages).length>=summary.latestTotal||!data.goodsList.length)break;
   }}
   const products=collectProducts(pages);summary.unique=products.length;summary.status=products.length===summary.latestTotal&&summary.expected===summary.latestTotal?'complete':'count_mismatch';
   for(const g of products){all.push(g);const id=String(g.goodsId);statuses[id]??=[];if(!statuses[id].includes(status))statuses[id].push(status);}
   console.log('STATUS_DONE',entry.country,status,summary.unique,summary.status);
   }catch(e){summary.status='error';summary.error=e.message;const products=collectProducts(pages);summary.unique=products.length;for(const g of products){all.push(g);(statuses[String(g.goodsId)]??=[]).push(status);}console.log('STATUS_ERROR',entry.country,status,e.message);}
   await save(path.join(output,'bilan.json'),report);
  }
  const products=collectProducts([{goodsList:all}]);account.products=products.length;
  const categories=await json(path.join(folder,'categories.json'),{}),groups=new Map();Object.assign(sharedCategories,categories);for(const g of products){if(!groups.has(String(g.catId)))groups.set(String(g.catId),[]);groups.get(String(g.catId)).push(g);}
  let done=0;for(const [catId,samples] of groups){if(!categories[catId]?.name&&sharedCategories[catId]?.name)categories[catId]=sharedCategories[catId];if(!categories[catId]?.name){let lastError;for(const sample of samples.slice(0,3)){try{const detail=await read('bg.local.goods.detail.query',{goodsId:sample.goodsId});if(String(detail.catId)!==catId||!detail.catName)throw Error('Catégorie détaillée non confirmée');categories[catId]={name:detail.catName,sampleGoodsId:String(sample.goodsId),sourceCountry:entry.country};sharedCategories[catId]=categories[catId];lastError=null;break;}catch(e){lastError=e.message;}}if(lastError)account.categoryErrors.push({catId,error:lastError});await save(path.join(folder,'categories.json'),categories);}done++;if(done%30===0)console.log('CATEGORIES',entry.country,done,groups.size);}await save(path.join(folder,'categories.json'),categories);
  products.sort((a,b)=>String(categories[String(a.catId)]?.name||'').localeCompare(String(categories[String(b.catId)]?.name||''))||String(a.goodsName).localeCompare(String(b.goodsName))||String(a.goodsId).localeCompare(String(b.goodsId)));
  const rows=products.map(g=>row(entry.country,account.mallId,g,categories,statuses));await csv(path.join(folder,'produits.csv'),rows);
  await writeFile(path.join(folder,'produits.jsonl'),products.map(g=>JSON.stringify({country:entry.country,mallId:account.mallId,categoryPath:categories[String(g.catId)]?.name||null,searchTypes:statuses[String(g.goodsId)],...g})).join('\n')+'\n',{mode:0o600});
  account.categories=groups.size;account.unclassified=products.filter(g=>!categories[String(g.catId)]?.name).length;
  account.status=account.statuses.every(s=>s.status==='complete')&&!account.unclassified?'complete':'partial';
  try{const {default:ExcelJS}=await import(pathToFileURL(excelModule).href);const workbook=new ExcelJS.stream.xlsx.WorkbookWriter({filename:path.join(folder,'produits.xlsx'),useStyles:false,useSharedStrings:false});const sheet=workbook.addWorksheet(entry.country);sheet.addRow(columns).commit();for(const values of rows)sheet.addRow(values).commit();sheet.commit();await workbook.commit();account.excel=true;}catch(e){account.excel=false;account.excelError=e.message;}
  console.log('COUNTRY_DONE',entry.country,account.products,account.categories,account.status);await save(path.join(output,'bilan.json'),report);
 }
 // Two accounts at a time; calls within an account are spaced and paginated.
 let cursor=0;await Promise.all(Array.from({length:2},async()=>{while(cursor<results.length){const next=results[cursor++];try{await exportAccount(next);}catch(e){next.account.status='error';next.account.error=e.message;console.log('COUNTRY_ERROR',next.entry.country,e.message);await save(path.join(output,'bilan.json'),report);}}}));
 report.finishedAt=new Date().toISOString();report.totalProducts=report.accounts.reduce((n,a)=>n+(a.products||0),0);report.completeCountries=[...new Set(report.accounts.filter(a=>a.status==='complete').map(a=>a.country))];report.incompleteCountries=report.requestedCountries.filter(c=>!report.completeCountries.includes(c));report.complete=!report.incompleteCountries.length;
 const combined=createWriteStream(path.join(output,'tous-les-produits.csv'),{mode:0o600});combined.write('\uFEFF'+columns.map(csvCell).join(';')+'\r\n');for(const {key} of results){try{const content=await readFile(path.join(output,key,'produits.csv'),'utf8');const body=content.slice(content.indexOf('\n')+1);if(!combined.write(body))await once(combined,'drain');}catch(e){if(e.code!=='ENOENT')throw e;}}
 await new Promise((resolve,reject)=>{combined.once('error',reject);combined.end(resolve);});await save(path.join(output,'bilan.json'),report);console.log('FINISHED',JSON.stringify({products:report.totalProducts,completeCountries:report.completeCountries,incompleteCountries:report.incompleteCountries}));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const output=process.argv[2];run({output}).catch(e=>{console.error(e.message);process.exitCode=1;});}
