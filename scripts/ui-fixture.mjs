// Synthetic full UI only; never start server.mjs or contact a provider.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {selectProblemOrders,paginateProblemOrders} from '../src/problem-typology.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
const root=path.resolve('public'),classify=currentProblemClassifier();
const reasons=['Commande déjà expédiée sur la plateforme','Unité de poids invalide','Poids non renseigné dans Erplain'];
const rows=Array.from({length:120},(_,i)=>({id:'fake-'+i,reference:'TEST-'+String(i).padStart(5,'0'),recipient:'Client fictif',channel:'temu',account_manager:'temu',address:{country:i%2?'BE':'FR',city:'Ville test',postalCode:'00000'},sku_lines:[{sku:'SKU-TEST',source_sku:'SKU-TEST',quantity:3,mapping_exists:true}],source_payload:{},source_date:'10/10/26',received_at:'2026-10-10T09:00:00Z',label_status:'blocked',erp_status:'live_review',tracking_status:'not_shipped',invoice_status:'not_due',carrier:'temu',issue:reasons[i%3],erp_live:{},simulation:false}));
const metrics=[];
http.createServer((req,res)=>{const begin=performance.now(),u=new URL(req.url,'http://localhost'),p=u.pathname;res.setHeader('Content-Security-Policy',"connect-src 'self';object-src 'none'");
 const json=(value,status=200)=>{metrics.push(performance.now()-begin);res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(p==='/test-metrics')return json({scope:'Synthetic UI / 120 fictional orders / no production timing',requests:metrics.length,maxMs:Math.max(0,...metrics)});
 if(p.startsWith('/api/')){
  if(req.method!=='GET'&&!['/api/orders/processing','/api/partial/visible'].includes(p))return json({error:'Fixture refuses business writes'},405);
  if(p==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': fixture\n\n');return;}
  if(p==='/api/me')return json({email:'isolated@example.invalid',role:'admin',permissions:[]});
  if(p==='/api/status')return json({setupNeeded:false});
  if(p==='/api/orders'||p==='/api/order-problem-types'){
   const base=rows.filter(o=>(!u.searchParams.get('country')||o.address.country===u.searchParams.get('country'))&&(!u.searchParams.get('search')||o.reference.includes(u.searchParams.get('search'))));
   const result=selectProblemOrders(base,p==='/api/order-problem-types'?[]:u.searchParams.getAll('problem-label'),classify);
   if(p==='/api/order-problem-types')return json({problemTypes:result.problemTypes});
   return json({...paginateProblemOrders(result,Number(u.searchParams.get('page')||1),Number(u.searchParams.get('pageSize')||50)),summary:{total:result.total,labels:0,blocked:result.total,delivered:0},transportStats:[]});
  }
  if(p==='/api/erplain/live-capacity')return json({total:0,missing:0});
  if(p==='/api/dashboard')return json({mappings:0,orders:120,incomplete:120,ready:0,labels:0});
  if(p==='/api/erplain/progress')return json({weights:{total:0,done:0,cached:0,errors:[]},stocks:{total:0,done:0},orders:{total:120,complete:0,processing:0,pending:0,review:120,bc:0,bl:0,details:[]}});
  return json({rows:[],at:new Date().toISOString()});
 }
 const file=path.resolve(root,p==='/'?'index.html':p.slice(1));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json({},404);
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(file));
}).listen(Number(process.env.UI_FIXTURE_PORT||31234),'127.0.0.1',()=>console.log('UI fixture ready'));
