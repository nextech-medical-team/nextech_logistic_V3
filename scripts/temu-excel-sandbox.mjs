import {loadTrackingPreview} from './local-tracking-preview.mjs';
import {localProductionReader} from './local-status-preview.mjs';
// Loopback-only test server. Erplain TEST uses a separate, verified connector.
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {excelMargins} from './temu-excel-margins.mjs';
import {excelLabels,excelLabelShops} from './temu-excel-labels.mjs';
import {localLabels} from './temu-local-label.mjs';
import {loadTestApi,testDocuments} from './temu-erplain-test.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTemuExcelTestDatabase} from '../test/support/temu-excel-db.mjs';
import {temuExcelImportRoutes} from '../src/temu-excel-import.mjs';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const port=Number(process.env.TEMU_EXCEL_TEST_PORT||31235);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Port de test invalide');
const dataDirectory=fileURLToPath(new URL('../data/temu-excel-local/',import.meta.url));
await mkdir(dataDirectory,{recursive:true,mode:0o700});
const db=await createTemuExcelTestDatabase(path.join(dataDirectory,'db')),user={email:'test-local@example.invalid',role:'admin',permissions:[]};
await db.exec("ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_test jsonb");
let documents,labelService,statusReader,trackingReader;
async function labelsService(){if(!labelService)labelService=localLabels({db,documents:await testService(),directory:path.join(dataDirectory,'labels')});return labelService;}
async function testService(){if(!documents)documents=testDocuments({db,api:await loadTestApi(fileURLToPath(new URL('../.env.erplain-test',import.meta.url))),directory:path.join(dataDirectory,'documents')});return documents;}
for(const o of await (await testService()).orders())await db.query('UPDATE orders SET erp_test=$2 WHERE id=$1',[o.id,JSON.stringify(o.documents)]);
const realLabels=await excelLabels({db,documents:await testService(),shops:()=>excelLabelShops(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)))});
const marginService=excelMargins({db,documents:await testService()});
const localHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw Error('Requête trop volumineuse');parts.push(chunk);}return JSON.parse(Buffer.concat(parts).toString()||'{}');}
const browserSetup=`document.title='TEST LOCAL · Import TEMU';
const banner=document.createElement('div');banner.textContent='ESPACE DE TEST LOCAL — Erplain TEST 101406. Imports conservés localement. Étiquettes TEMU : achats réels.';banner.style.cssText='background:#d7f3e9;color:#103b32;padding:14px;font-weight:bold;position:sticky;top:0;z-index:9999';document.body.prepend(banner);const testLink=document.createElement('a');testLink.href='/erplain-test';testLink.textContent=' → Tester les BC et BL';banner.append(testLink);
const style=document.createElement('style');style.textContent='.notice,.live-top-banner,#movement-watch-panel,#live-capacity,#purchase-import-panel{display:none!important}';document.head.append(style);
const timer=setInterval(()=>{if(typeof user!=='undefined'&&user&&typeof currentView!=='undefined'&&document.querySelector('#app')?.hidden===false&&document.querySelector('#page-info')?.textContent){clearInterval(timer);show(new URLSearchParams(location.search).get('view')==='orders'?'orders':'imports').then(()=>{document.getElementById('import-kind').value='temu_excel';document.getElementById('import-kind').dispatchEvent(new Event('change'));});}},100);`;
const server=http.createServer(async(req,res)=>{
 try{
  if(!localHosts.has(req.headers.host))return json(res,403,{error:'Serveur réservé au test local'});
  const url=new URL(req.url,'http://'+req.headers.host),p=url.pathname;
  res.setHeader('Content-Security-Policy',"connect-src 'self';object-src 'none';frame-ancestors 'none'");
  res.setHeader('Cache-Control','no-store');
  if(req.headers.origin&&req.headers.origin!==url.origin)return json(res,403,{error:'Origine différente du test local'});
  if(p==='/api/margins'&&req.method==='GET'){const result=await marginService.get();return json(res,result.error?503:200,result);}
  if(p==='/api/local-temu/shops'&&req.method==='GET')return json(res,200,{shops:await realLabels.shops()});
  if(p==='/api/local-temu/pdf'&&req.method==='GET'){const bytes=await realLabels.pdf(url.searchParams.get('reference'),url.searchParams.get('package'));res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=etiquette-TEMU.pdf'});res.end(bytes);return;}
  if(['/api/local-temu/prepare','/api/local-temu/buy','/api/local-temu/recover'].includes(p)&&req.method==='POST'){
   if(req.headers.origin!==url.origin||req.headers['x-local-test']!=='1')return json(res,403,{error:'Origine locale requise'});
   return json(res,200,await realLabels[p.split('/').at(-1)](await body(req)));
  }
  if(p==='/api/local-erplain/label'&&req.method==='POST'){if(req.headers.origin!==url.origin||req.headers['x-local-test']!=='1')return json(res,403,{error:'Origine locale requise'});return json(res,200,{label:await (await labelsService()).create((await body(req)).id)});}
  if(p.startsWith('/api/local-erplain/label/')&&req.method==='GET'){const bytes=await (await labelsService()).bytes(decodeURIComponent(p.slice('/api/local-erplain/label/'.length)));res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=etiquette-TEST.pdf'});res.end(bytes);return;}
  if(p==='/api/local-tracking-preview'&&req.method==='POST'){if(req.headers.origin!==url.origin||req.headers['x-local-test']!=='1')return json(res,403,{error:'Origine locale requise'});trackingReader??=await loadTrackingPreview();return json(res,200,await trackingReader(await body(req)));}
  if(p==='/status-preview'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('./local-status-preview.html',import.meta.url)));return;}
  if(p==='/api/local-status-preview'&&req.method==='POST'){if(req.headers.origin!==url.origin||req.headers['x-local-test']!=='1')return json(res,403,{error:'Origine locale requise'});statusReader??=await localProductionReader(db);return json(res,200,await statusReader(await body(req)));}
  if(p==='/temu-local-table.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('./temu-local-table.js',import.meta.url)));return;}
  if(p==='/api/local-erplain/orders'&&req.method==='GET')return json(res,200,{orders:await (await testService()).orders()});
  if(p==='/api/local-erplain/create'&&req.method==='POST'){if(req.headers.origin!==url.origin||req.headers['x-local-test']!=='1')return json(res,403,{error:'Action réservée à la page de test locale'});return json(res,200,await (await testService()).create(await body(req)));}
  if(p==='/erplain-test'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(new URL('./temu-erplain-test.html',import.meta.url)));return;}
  if(await temuExcelImportRoutes({p,req,res,user,body,json,db,permitted:()=>{}}))return;
  if(p.startsWith('/api/')){
   if(req.method!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(p))return json(res,405,{error:'Espace de test : seul l’import Excel TEMU est activé.'});
   if(p==='/api/status')return json(res,200,{setupNeeded:false});
   if(p==='/api/me')return json(res,200,user);
   if(p==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': local test\n\n');return;}
   const orders=(await db.query('SELECT * FROM orders ORDER BY reference')).rows;
   const summary={total:orders.length,labels:0,blocked:orders.length,delivered:0};
   if(p==='/api/dashboard')return json(res,200,{mappings:0,orders:orders.length,incomplete:orders.length,ready:0,labels:0});
   if(p==='/api/erplain/live-capacity')return json(res,200,{total:0,missing:0});
   if(p==='/api/erplain/progress')return json(res,200,{weights:{total:0,done:0,cached:0,errors:[]},stocks:{total:0,done:0},orders:{total:0,complete:0,processing:0,pending:0,review:0,bc:0,bl:0,details:[]}});
   if(p==='/api/orders'){
    const search=(url.searchParams.get('search')||'').toLowerCase(),country=url.searchParams.get('country');
    const selected=orders.filter(o=>(!search||o.reference.toLowerCase().includes(search)||o.recipient.toLowerCase().includes(search))&&(!country||o.address.country===country));
    const size=Math.max(1,Math.min(200,Number(url.searchParams.get('pageSize'))||50)),pages=Math.max(1,Math.ceil(selected.length/size)),page=Math.max(1,Math.min(pages,Number(url.searchParams.get('page'))||1));
    const rows=[];
    for(const o of selected.slice((page-1)*size,page*size)){
     const lines=(await db.query('SELECT source_sku,quantity FROM lines WHERE order_id=$1',[o.id])).rows;
     const erp_test=await (await testService()).state(o.reference),test_label=await (await labelsService()).info(o,erp_test);
     rows.push({...o,erp_test,test_label,temu_label:await realLabels.info(o.reference),account_manager:'temu',received_at:o.source_payload.temuExcel.importedAt,erp_live:{},simulation:false,sku_lines:lines.map(l=>({sku:l.source_sku,source_sku:l.source_sku,quantity:Number(l.quantity)})),line_count:lines.length,item_quantity:lines.reduce((n,l)=>n+Number(l.quantity),0)});
    }
    return json(res,200,{rows,total:selected.length,page,pages,summary,transportStats:[]});
   }
   if(p==='/api/order-problem-types')return json(res,200,{problemTypes:[]});
   return json(res,200,{rows:[],at:new Date().toISOString()});
  }
  if(p==='/temu-excel-sandbox.js'){res.setHeader('Content-Type','text/javascript');res.end(browserSetup);return;}
  const filename=path.resolve(root,p==='/'?'index.html':p.slice(1));
  if(!filename.startsWith(root))return json(res,404,{error:'Introuvable'});
  let bytes=await readFile(filename);
  if(p==='/')bytes=Buffer.from(bytes.toString().replace('<script src="/migration-preparation.js"></script>','').replace('</body>','<script src="/temu-excel-sandbox.js"></script><script src="/temu-local-table.js"></script></body>'));
  res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');res.end(bytes);
 }catch(error){json(res,error.code==='ENOENT'?404:400,{error:error.message});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Test import TEMU : http://127.0.0.1:${port}\nImports persistants en local. Connecteur réservé à Erplain TEST 101406.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(async()=>{await db.close();process.exit(0);});});
