// Real TEMU purchases, isolated from production order/Erplain writes.
import {temuApi} from '../src/temu-api.mjs';
import {loadShopVault} from '../src/temu-shop-vault.mjs';
import {connectTemuShops} from '../src/temu-shop-clients.mjs';
import {initializeTemuShipping,temuShipping} from '../src/temu-shipping.mjs';
import {excelMargins} from './temu-excel-margins.mjs';
import {labelIdentity} from './temu-local-label.mjs';

export async function excelLabelShops(directory,{factory=temuApi,shopLoader=loadShopVault,configLoader}={}){
 const {clients,countryByMall,config}=await connectTemuShops(directory,{apiFactory:factory,shopLoader,configLoader});
 return new Map([...clients].map(([mall,api])=>[mall,{api,country:config.TEMU_COUNTRIES?.[mall]||countryByMall.get(mall)||''}]));
}
export async function excelLabels({db,documents,shops}){
 await db.exec('ALTER TABLE orders ADD COLUMN IF NOT EXISTS weight_kg numeric');
 await initializeTemuShipping(db);
 await db.exec('CREATE TABLE IF NOT EXISTS excel_label_bindings(reference text PRIMARY KEY,mall text NOT NULL,documents text NOT NULL,plan text)');
 const margins=excelMargins({db,documents});
 let clients;const services=new Map(),active=new Set();
 async function connections(){if(!clients)clients=await shops();return clients;}
 async function order(reference){
  const o=(await db.query("SELECT * FROM orders WHERE channel='temu' AND reference=$1",[reference])).rows[0];
  if(!o||o.archived||o.source_payload?.origin!=='temu_excel')throw Error('Commande Excel TEMU active requise');
  return o;
 }
 async function ready(reference){const o=await order(reference);return {o,key:labelIdentity(o,await documents.state(reference))};}
 async function binding(reference){return (await db.query('SELECT * FROM excel_label_bindings WHERE reference=$1',[reference])).rows[0];}
 async function verifyDetail(ref,result){
  const local=await order(ref);
  const lines=(await db.query('SELECT source_line,quantity FROM lines WHERE order_id=$1',[local.id])).rows;
  const canonical=rows=>JSON.stringify(rows.map(l=>[String(l.orderSn??l.source_line),Number(l.quantity)]).sort((a,b)=>a[0].localeCompare(b[0])));
  if(result.parentOrderMap?.parentOrderSn!==ref||!lines.length||!Array.isArray(result.orderList)||canonical(lines)!==canonical(result.orderList))throw Error('Articles ou quantités différents entre Excel et TEMU');
 }
 async function service(reference,mall){
  const shop=(await connections()).get(mall);if(!shop)throw Error('Sélectionnez la boutique TEMU');
  const o=await order(reference);if(shop.country&&shop.country!==o.address?.country)throw Error('Pays de la boutique différent de la commande Excel');
  if(!services.has(mall)){
   const api={canBuy:shop.api.canBuy,buy:r=>shop.api.buy(r),pdf:u=>shop.api.pdf(u),async read(type,data){
    const result=await shop.api.read(type,data);
    if(type==='bg.order.detail.v2.get'){
     await verifyDetail(data.parentOrderSn,result);
    }
    return result;
   }};
   // Only the local Excel hold is superseded by verified TEST BC/BL; no production suspension is changed.
   services.set(mall,temuShipping(db,api,{fixedWeight:'0.25',quoteOrderPolicy:async ref=>{
    const {o,key}=await ready(ref),b=await binding(ref);
    if(!b||b.mall!==mall||b.documents!==key)throw Error('BC/BL ou boutique modifiés : refaire le devis');
    if(o.suspension?.active&&o.suspension.note!=='Import Excel TEMU : vérifier la commande et sa boutique avant toute préparation.')throw Error('Commande suspendue');
   }}));
  }
  return services.get(mall);
 }
 async function locked(reference,fn){if(active.has(reference))throw Error('Commande déjà en traitement');active.add(reference);try{return await fn();}finally{active.delete(reference);}}
 return {
  async shops(){return [...await connections()].map(([mall,s])=>({mall,country:s.country,purchaseEnabled:s.api.canBuy!==false}));},
  async prepare({reference,mall}){return locked(reference,async()=>{
   const {key}=await ready(reference);const svc=await service(reference,String(mall));
   const previous=(await db.query('SELECT * FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
   if(previous?.attempt_id||previous?.packages?.length)throw Error('Achat déjà engagé : utiliser Récupérer');
   await db.query('INSERT INTO excel_label_bindings(reference,mall,documents) VALUES($1,$2,$3) ON CONFLICT(reference) DO UPDATE SET mall=excluded.mall,documents=excluded.documents,plan=NULL',[reference,String(mall),key]);
   const plan=await svc.prepare(reference);
   await db.query('UPDATE excel_label_bindings SET plan=$2 WHERE reference=$1',[reference,plan.id]);
   const snapshot=await margins.get({reference});
   return {...plan,margin:snapshot.rows[0],marginCalculatedAt:snapshot.calculatedAt};
  });},
  async buy({reference,planId,amount,confirmPurchase}){return locked(reference,async()=>{
   if(confirmPurchase!==true)throw Error('Confirmation de l’achat réel requise');
   const {key}=await ready(reference),b=await binding(reference);
   if(!b||b.documents!==key||b.plan!==planId)throw Error('Devis ou BC/BL modifiés : refaire le devis');
   return (await service(reference,b.mall)).buy(reference,planId,amount);
  });},
  async recover({reference,mall}){return locked(reference,async()=>{
   await order(reference);let b=await binding(reference);
   const chosen=b?.mall||String(mall||''),svc=await service(reference,chosen);
   const detail=await (await connections()).get(chosen).api.read('bg.order.detail.v2.get',{parentOrderSn:reference});
   await verifyDetail(reference,detail);
   if(!b)await db.query('INSERT INTO excel_label_bindings(reference,mall,documents) VALUES($1,$2,$3)',[reference,chosen,'recovery']);
   return svc.recover(reference);
  });},
  async info(reference){
   const j=(await db.query('SELECT status,error,result FROM temu_label_jobs WHERE reference=$1',[reference])).rows[0];
   const docs=(await db.query('SELECT package FROM temu_label_documents WHERE reference=$1',[reference])).rows;
   return j?{...j,documents:docs.map(d=>({package:d.package,url:'/api/local-temu/pdf?'+new URLSearchParams({reference,package:d.package})}))}:null;
  },
  async pdf(reference,pkg){await order(reference);const row=(await db.query('SELECT pdf FROM temu_label_documents WHERE reference=$1 AND package=$2',[reference,pkg])).rows[0];if(!row)throw Error('PDF TEMU indisponible');return Buffer.from(row.pdf);}
 };
}
