import {chooseActiveStockVariant} from './active-stock-choice.mjs';
import {stockChoiceLocation} from './stock-choice-location.mjs';
export function equivalencePair(a,b){
 const values=[a,b].map(v=>{if(typeof v!=='string'||!v.trim()||v.trim().length>199)throw Error('Deux SKU Erplain sont requis');return v.trim();});
 if(values[0]===values[1])throw Error('Choisir deux SKU différents');return values.sort();
}
export async function initializeEquivalences(db){await db.exec(`CREATE TABLE IF NOT EXISTS product_equivalences(sku_a TEXT NOT NULL,sku_b TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',active BOOLEAN NOT NULL DEFAULT true,origin TEXT NOT NULL DEFAULT 'manual',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(sku_a,sku_b),CHECK(sku_a<>sku_b));`);}
// Human instruction 2026-10-13: only explicit catalogue entry may save a pair.
// Preserve these exports for callers; replacement and history never write pairs.
export async function rememberEquivalence(){return {saved:false};}
export async function importEquivalenceHistory(){return {skipped:0,disabled:true};}
export async function readEquivalentProduct(api,sku,selection={}){
 const response=await api.request('query V3EquivalentCatalog($where:QueryVariantsWhereWhereConditions!){Variants(first:100,where:$where){data{id sku active track_inventory product{id label active} stock_levels(first:100){data{location{id} available on_hand} paginatorInfo{hasMorePages}}} paginatorInfo{hasMorePages}}}',{where:{column:'SKU',operator:'EQ',value:sku}});
 const found=response.Variants;if(!Array.isArray(found?.data)||found.paginatorInfo?.hasMorePages!==false)throw Error('API Erplain · Réponse produit incomplète');
 if(found.data.some(v=>v?.sku!==sku))throw Error('API Erplain · Recherche produit incohérente');
 if(found.data.some(v=>typeof v.active!=='boolean'||typeof v.product?.active!=='boolean'))throw Error('API Erplain · Activité produit non vérifiée');
 const exact=found.data.filter(v=>v.sku===sku&&v.active===true&&v.product?.active===true);
 if(!exact.length)throw Error(sku+' · SKU introuvable ou inactif dans Erplain');
 if(exact.length>1&&!selection.locationId)throw Error(sku+' · Emplacement requis pour départager les produits actifs');
 const v=selection.locationId?chooseActiveStockVariant(exact,{sku,...selection}).variant:exact[0],levels=v.stock_levels;let available=null,stockError=null;
 if(v.track_inventory!==false){if(!Array.isArray(levels?.data)||!levels.data.length||levels.paginatorInfo?.hasMorePages!==false||levels.data.some(s=>[s.available,s.on_hand].some(value=>!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))))stockError='Stock non vérifié — réponse API incomplète';else available=levels.data.reduce((n,s)=>n+Math.max(0,Math.min(Number(s.available),Number(s.on_hand))),0);}
 if(selection.locationId&&v.track_inventory!==false){
  if(!Array.isArray(levels?.data)||levels.paginatorInfo?.hasMorePages!==false)stockError='Stock non vérifié — réponse API incomplète';
  else{const here=levels.data.filter(l=>String(l.location?.id)===String(selection.locationId));
   if(here.length>1||here.some(l=>[l.available,l.on_hand].some(value=>!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))))stockError='Stock non vérifié — réponse API incomplète';
   else{available=here.length?Math.max(0,Math.min(Number(here[0].available),Number(here[0].on_hand))):0;stockError=null;}
  }
  if(stockError)available=null;
 }
 return {sku,label:v.product?.label||sku,available,stockError,stockTracked:v.track_inventory!==false,variantId:String(v.id),locationId:selection.locationId?String(selection.locationId):null};
}
export async function equivalenceApi({p,url,req,res,db,user,body,json,permitted,api,directory}){
 if(!p.startsWith('/api/equivalences'))return false;
 const readProduct=async sku=>readEquivalentProduct(api,sku,{locationId:await stockChoiceLocation(directory)});
 if(p==='/api/equivalences'&&req.method==='GET'){const search=String(url.searchParams.get('search')||'').slice(0,199),page=Math.max(1,Math.trunc(Number(url.searchParams.get('page')))||1);const args=['%'+search+'%'];const where='WHERE sku_a ILIKE $1 OR sku_b ILIKE $1';const rows=(await db.query(`SELECT * FROM product_equivalences ${where} ORDER BY sku_a,sku_b LIMIT 100 OFFSET $2`,[...args,(page-1)*100])).rows;const total=Number((await db.query(`SELECT count(*) n FROM product_equivalences ${where}`,args)).rows[0].n);json(res,200,{rows,total,page});return true;}
 if(p==='/api/equivalences/suggestions'&&req.method==='GET'){
  const sku=String(url.searchParams.get('sku')||'').trim();if(!sku||sku.length>199)throw Error('SKU Erplain requis');
  json(res,200,{rows:[]});return true;
 }
 if(p==='/api/equivalences/product'&&req.method==='GET'){const sku=String(url.searchParams.get('sku')||'').trim();if(!sku||sku.length>199)throw Error('SKU Erplain requis');json(res,200,await readProduct(sku));return true;}
 if(p==='/api/equivalences'&&req.method==='POST'){
  permitted(user,['admin','manager','operator']);const b=await body(req),pair=equivalencePair(b.sku_a,b.sku_b);if(typeof b.active!=='boolean')throw Error('État actif requis');const notes=String(b.notes||'').trim();if(notes.length>1000)throw Error('Commentaire limité à 1000 caractères');
  if(b.active){await readProduct(pair[0]);await readProduct(pair[1]);}
  await db.transaction(async tx=>{await tx.query("INSERT INTO product_equivalences(sku_a,sku_b,notes,active) VALUES($1,$2,$3,$4) ON CONFLICT(sku_a,sku_b) DO UPDATE SET notes=excluded.notes,active=excluded.active,origin='manual',updated_at=now()",[...pair,notes,b.active]);await tx.query("INSERT INTO audit(user_email,action,detail) VALUES($1,'equivalence.saved',$2)",[user.email,JSON.stringify({sku_a:pair[0],sku_b:pair[1],active:b.active})]);});json(res,200,{ok:true});return true;
 }
 return false;
}
