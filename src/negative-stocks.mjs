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
   const page=Number(rawPage),rows=(await db.query(`SELECT id,created_at,completed_at,requested_by,snapshot->>'locationId' AS location_id,jsonb_array_length(snapshot->'rows') AS product_count,(snapshot->>'unverified')::int AS unverified FROM negative_stock_history WHERE completed_at IS NOT NULL ORDER BY completed_at DESC,id LIMIT 21 OFFSET $1`,[(page-1)*20])).rows;
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

export function negativeStocksService(api,directory,{location=()=>stockChoiceLocation(directory)}={}){
 return {async page(rawPage='1'){
  if(!/^[1-9]\d{0,5}$/.test(String(rawPage)))throw Error('Page de stock invalide');
  const page=Number(rawPage),locationId=String(await location());
  await api.verify();
  const {Variants:v}=await api.request('query V3NegativeStocks($page:Int!){Variants(first:100,page:$page){paginatorInfo{lastPage total} data{id sku active track_inventory product{label active default_supplier{id label}} suppliers{supplier{id label}} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}}}}',{page});
  if(!Array.isArray(v?.data)||!Number.isInteger(v.paginatorInfo?.lastPage)||v.paginatorInfo.lastPage<page)throw Error('Lecture des stocks incomplète');
  const rows=[];let unverified=0;
  for(const variant of v.data){
   if(variant.active===false||variant.product?.active===false||variant.track_inventory===false)continue;
   const levels=variant.stock_levels;
   if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false){unverified++;continue;}
   const matches=levels.data.filter(level=>String(level.location?.id)===locationId);
   if(matches.length!==1){unverified++;continue;}
   const available=quantity(matches[0].available),onHand=quantity(matches[0].on_hand);
   if(available===null||onHand===null)unverified++;
   if((available!==null&&available<0)||(onHand!==null&&onHand<0))rows.push({variantId:String(variant.id),sku:variant.sku||'',label:variant.product?.label||'',supplier:variant.product?.default_supplier?.label||[...new Set((variant.suppliers||[]).map(entry=>entry.supplier?.label).filter(Boolean))].join(' ; ')||null,available,onHand});
  }
  return {rows,unverified,locationId,page,lastPage:v.paginatorInfo.lastPage,checkedAt:new Date().toISOString()};
 }};
}
