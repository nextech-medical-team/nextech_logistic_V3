import {stockChoiceLocation} from './stock-choice-location.mjs';
import {randomUUID} from 'node:crypto';

export async function initializeNegativeStocks(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS negative_stock_history(id TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),completed_at TIMESTAMPTZ,requested_by TEXT NOT NULL,next_page INTEGER NOT NULL DEFAULT 1,snapshot JSONB NOT NULL);`);
}

export function negativeStocksHistory(db,reader){
 return {
  async scan({page=1,runId=null}={},user){
   if(!Number.isSafeInteger(page)||page<1)throw Error('Page de stock invalide');
   let prior;
   if(runId){
    prior=(await db.query('SELECT * FROM negative_stock_history WHERE id=$1 AND requested_by=$2',[runId,user.email])).rows[0];
    if(!prior||prior.completed_at||prior.next_page!==page)throw Error('Lecture expirée ou page déjà enregistrée. Relancez la recherche.');
   }else if(page!==1)throw Error('Commencez la lecture à la première page');
   const data=await reader.page(String(page));
   if(prior&&prior.snapshot.scope!==data.scope)throw Error('Type de rapport modifié. Relancez la recherche.');
   if(prior&&prior.snapshot.locationId!==data.locationId)throw Error('Emplacement modifié pendant la lecture. Relancez la recherche.');
   const snapshot={...data,rows:[...(prior?.snapshot.rows||[]),...data.rows],unverified:(prior?.snapshot.unverified||0)+data.unverified};
   const completedAt=page===data.lastPage?data.checkedAt:null;
   if(prior){
    const result=await db.query('UPDATE negative_stock_history SET snapshot=$1, next_page=$2, completed_at=$3 WHERE id=$4 AND next_page=$5 AND completed_at IS NULL RETURNING id',[JSON.stringify(snapshot),page+1,completedAt,runId,page]);
    if(!result.rows.length)throw Error('Page déjà enregistrée. Relancez la recherche.');
   }else{
    runId=randomUUID();
    await db.query('INSERT INTO negative_stock_history(id,requested_by,next_page,snapshot,completed_at) VALUES($1,$2,$3,$4,$5)',[runId,user.email,page+1,JSON.stringify(snapshot),completedAt]);
   }
   return {...data,runId,saved:!!completedAt};
  },
  async list(rawPage='1'){
   if(!/^[1-9]\d{0,5}$/.test(String(rawPage)))throw Error('Page historique invalide');
   const page=Number(rawPage),rows=(await db.query(`SELECT id,created_at,completed_at,requested_by,snapshot->>'locationId' AS location_id,jsonb_array_length(snapshot->'rows') AS product_count,(snapshot->>'unverified')::int AS unverified FROM negative_stock_history WHERE completed_at IS NOT NULL AND snapshot->>'scope'=$2 ORDER BY completed_at DESC,id LIMIT 21 OFFSET $1`,[(page-1)*20,negativeStockReportScope])).rows;
   return {rows:rows.slice(0,20),page,hasMore:rows.length>20};
  },
  async get(id){
   const row=(await db.query('SELECT id,created_at,completed_at,requested_by,snapshot FROM negative_stock_history WHERE id=$1 AND completed_at IS NOT NULL',[id])).rows[0];
   if(!row)throw Error('Résultat historique introuvable');
   return row;
  }
 };
}

const quantity=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))?Number(value):null;

export const negativeStockReportScope='erp-orders-with-bl-negative-available-v1';

export function negativeStocksService(api,directory,{location=()=>stockChoiceLocation(directory)}={}){
 return {async page(rawPage='1'){
  if(!/^[1-9]\d{0,5}$/.test(String(rawPage)))throw Error('Page de stock invalide');
  const page=Number(rawPage),locationId=String(await location());
  await api.verify();
  const {Orders:documents}=await api.request('query V3NegativeStockOrders($page:Int!){Orders(first:50,page:$page){paginatorInfo{lastPage total} data{id label external_reference status dated_at shipping_orders(first:100,page:1){data{id label status} paginatorInfo{hasMorePages}} line_items{id sku label quantity location{id label} variant{id sku track_inventory product{label default_supplier{id label}} suppliers{supplier{id label}} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}}}}}}',{page});
  const last=documents?.paginatorInfo?.lastPage;
  if(!Array.isArray(documents?.data)||!Number.isInteger(last)||last<0||(last===0&&documents.data.length)||Math.max(1,last)<page)throw Error('Lecture des commandes ERP incomplète');
  const rows=[];let unverified=0;
  for(const order of documents.data){
   if(['cancelled','unpublished'].includes(order.status))continue;
   if(!order.id||!order.label||!order.status||!Array.isArray(order.line_items)){unverified++;continue;}
   const deliveryRead=await readOrderDeliveryLabels(api,order);
   unverified+=deliveryRead.unverified;
   const deliveries=deliveryRead.labels;
   if(!deliveries.length)continue;
   for(const line of order.line_items){
    // Shipping/handling lines have no inventory variant.
    const variant=line.variant;if(!variant)continue;
    if(!line.location?.id){unverified++;continue;}
    if(String(line.location.id)!==locationId)continue;
    if(variant.track_inventory===false)continue;
    if(variant.track_inventory!==true){unverified++;continue;}
    const levels=variant.stock_levels;
    if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false){unverified++;continue;}
    const matches=levels.data.filter(level=>String(level.location?.id)===String(line.location.id));
    if(matches.length!==1){unverified++;continue;}
    const available=quantity(matches[0].available),onHand=quantity(matches[0].on_hand),orderQuantity=quantity(line.quantity);
    if(available===null||onHand===null||orderQuantity===null)unverified++;
    if(available===null||available>=0||orderQuantity===null||orderQuantity<=0)continue;
    rows.push({bcId:String(order.id),bcLabel:order.label,externalReference:order.external_reference||'',blLabel:deliveries.join(' ; ')||null,bcStatus:order.status,bcDate:order.dated_at||null,lineId:String(line.id||''),variantId:String(variant.id),sku:variant.sku||line.sku||'',label:line.label||variant.product?.label||'',supplier:variant.product?.default_supplier?.label||[...new Set((variant.suppliers||[]).map(entry=>entry.supplier?.label).filter(Boolean))].join(' ; ')||null,orderQuantity,available,onHand,locationLabel:line.location.label||locationId});
   }
  }
  return {scope:negativeStockReportScope,rows,unverified,locationId,page,lastPage:Math.max(1,last),checkedAt:new Date().toISOString()};
 }};
}

async function readOrderDeliveryLabels(api,order){
 const labels=[],seen=new Set();let connection=order.shipping_orders,unverified=0;
 for(let page=1;page<=100;page++){
  if(!Array.isArray(connection?.data)||typeof connection.paginatorInfo?.hasMorePages!=='boolean')throw Error('Liste des BL du BC incomplète');
  for(const bl of connection.data){
   if(!bl.id||seen.has(String(bl.id)))throw Error('Pagination des BL incohérente');
   seen.add(String(bl.id));
   if(typeof bl.status!=='string'||!bl.status.trim()){unverified++;continue;}
   if(!['cancelled','unpublished'].includes(bl.status)&&bl.label)labels.push(bl.label);
  }
  if(!connection.paginatorInfo.hasMorePages)return {labels,unverified};
  if(!connection.data.length||page===100)throw Error('Liste des BL du BC incomplète');
  const result=await api.request('query V3NegativeStockOrderDeliveryPage($id:ID!,$page:Int!){Order(id:$id){id shipping_orders(first:100,page:$page){data{id label status} paginatorInfo{hasMorePages}}}}',{id:String(order.id),page:page+1});
  if(String(result.Order?.id)!==String(order.id))throw Error('Identité du BC non confirmée');
  connection=result.Order.shipping_orders;
 }
}
