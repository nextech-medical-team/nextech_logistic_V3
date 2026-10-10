import {shopifyObservationApi,observationQuery,observationRow,observedProcess} from './shopify-observation-api.mjs';
import {erplainAccount} from './erplain-accounts.mjs';

export async function initializeShopifyObservation(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS shopify_observation(id INTEGER PRIMARY KEY CHECK(id=1),snapshot JSONB NOT NULL);`);
}
export function freshObservation(now=new Date()){
 return {start:new Date(+now-28*86400000).toISOString(),end:now.toISOString(),phase:'shopify',cursor:null,cursors:[],rows:[],offset:0,errors:[],updatedAt:now.toISOString()};
}
async function save(db,s){s.updatedAt=new Date().toISOString();await db.query('INSERT INTO shopify_observation VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot',[JSON.stringify(s)]);}
export async function readObservation(db){return (await db.query('SELECT snapshot FROM shopify_observation WHERE id=1')).rows[0]?.snapshot||null;}

export async function erplainObservation(api,refs){
 const where={OR:refs.map(value=>({column:'EXTERNAL_REFERENCE',operator:'EQ',value}))},bc=[],bl=[];
 for(const [field,type,target,extra] of [['Orders','QueryOrdersWhereWhereConditions',bc,'shipping_orders(first:100){data{id label status} paginatorInfo{hasMorePages}}'],['ShippingOrders','QueryShippingOrdersWhereWhereConditions',bl,'']]){
  let ended=false;
  for(let page=1;page<=100;page++){
   const q=`query LectureShopifyErplain($where:${type},$page:Int!){${field}(first:100,page:$page,where:$where){data{id label status external_reference ${extra}} paginatorInfo{hasMorePages}}}`;
   const r=(await api.request(q,{where,page}))[field];
   if(!Array.isArray(r?.data)||typeof r.paginatorInfo?.hasMorePages!=='boolean')throw Error('Erplain : pagination '+field+' non vérifiable');
   if(r.data.some(x=>!refs.includes(x.external_reference)))throw Error('Erplain : référence non concordante');
   target.push(...r.data);if(!r.paginatorInfo.hasMorePages){ended=true;break;}
   if(!r.data.length)throw Error('Erplain : page vide avant la fin');
  }
  if(!ended)throw Error('Erplain : pagination incomplète');
 }
 return refs.map(reference=>{
  const orders=bc.filter(b=>b.external_reference===reference),deliveries=[...new Map([...orders.flatMap(b=>b.shipping_orders?.data||[]),...bl.filter(b=>b.external_reference===reference)].map(b=>[String(b.id),b])).values()];
  return {reference,bc:orders.map(({id,label,status})=>({id,label,status})),bl:deliveries,erpError:orders.some(b=>b.shipping_orders?.paginatorInfo?.hasMorePages)?'Erplain : liste des BL liés incomplète':null,erpAt:new Date().toISOString()};
 });
}

export function shopifyObservationWorker(db,directory,{reader=shopifyObservationApi(directory),erp=erplainAccount(directory,'source'),shouldStop=()=>false}={}){
 let running=false;
 return {async run(){if(running||shouldStop())return;running=true;
  try{await db.withLocks(['shopify-observation'],async()=>{
   const s=await readObservation(db);if(!s||!['shopify','erplain'].includes(s.phase)||shouldStop())return;
   try{
    if(s.phase==='shopify'){
     const {data,shop}=await reader.read(observationQuery,{after:s.cursor,search:`created_at:>='${s.start}' created_at:<='${s.end}'`}),p=data.orders;
     if(!Array.isArray(p?.nodes)||typeof p.pageInfo?.hasNextPage!=='boolean')throw Error('Shopify : pagination non vérifiable');
     const next=p.pageInfo.hasNextPage?p.pageInfo.endCursor:null;
     if(p.pageInfo.hasNextPage&&(!next||s.cursors.includes(next)||!p.nodes.length))throw Error('Shopify : pagination interrompue');
     const rows=new Map(s.rows.map(r=>[r.id,r]));for(const n of p.nodes){const row=observationRow(n,shop,s.start,s.end);rows.set(row.id,row);}
     s.rows=[...rows.values()];s.shop=shop;s.cursor=next;if(next)s.cursors.push(next);else s.phase=s.rows.length?'erplain':'complete';
    }else{
     const group=s.rows.slice(s.offset,s.offset+20);
     try{const found=await erplainObservation(erp,group.map(r=>r.reference));for(const row of group)Object.assign(row,found.find(r=>r.reference===row.reference));}
     catch(e){for(const row of group)row.erpError=e.message;s.errors.push('Lecture Erplain impossible pour '+group.length+' commandes');}
     s.offset+=group.length;if(s.offset>=s.rows.length)s.phase=s.errors.length||s.rows.some(r=>r.erpError)?'partial':'complete';
    }
   }catch(e){s.phase='error';s.errors.push(e.message);}
   if(['complete','partial','error'].includes(s.phase))s.finishedAt=new Date().toISOString();await save(db,s);
  });}finally{running=false;}
 }};
}

export async function observationView(db,s,{search='',page=1}={}){
 if(!s)return {phase:'empty',rows:[],total:0,page:1,pages:1};
 const refs=s.rows.map(r=>r.reference);
 const report=(await db.query("SELECT value FROM settings WHERE key='shopify_report_observation'")).rows[0]?.value;
 const reportMatches=report?.shop===s.shop?report.matches||{}:{};
 const v3=refs.length?(await db.query(`SELECT o.id,o.reference,o.source_reference,o.source_payload,o.erp_live,o.archived,j.status job_status,
 EXISTS(SELECT 1 FROM marketplace_order_links m WHERE m.order_id=o.id AND m.channel='shopify' AND m.shop=$2) linked
 FROM orders o LEFT JOIN erp_live_jobs j ON j.order_id=o.id WHERE o.channel='shopify' AND (o.reference=ANY($1::text[]) OR o.source_reference=ANY($1::text[]))`,[refs,s.shop||''])).rows:[];
 const rows=s.rows.map(r=>{
  const matches=v3.filter(o=>(o.reference===r.reference||o.source_reference===r.reference)&&(!o.source_payload?.sourceShop||o.source_payload.sourceShop===r.shop));
  return {...r,reportEvidence:reportMatches[r.reference]||[],reportCheckedAt:report?.shop===s.shop?report.checkedAt:null,present:matches.length>0,archived:matches.length>0&&matches.every(o=>o.archived),process:observedProcess(matches)};
 }).filter(r=>!search||JSON.stringify(r).toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')));
 const pages=Math.max(1,Math.ceil(rows.length/50));page=Math.min(pages,Math.max(1,Number.parseInt(page)||1));
 return {phase:s.phase,start:s.start,end:s.end,updatedAt:s.updatedAt,finishedAt:s.finishedAt,errors:s.errors,total:rows.length,collected:s.rows.length,checked:s.offset,page,pages,rows:rows.slice((page-1)*50,page*50)};
}
export async function shopifyObservationRoutes({p,url,req,res,db,json,user,permitted}){
 if(p!=='/api/lecture-shopify')return false;
 if(req.method==='GET'){json(res,200,await observationView(db,await readObservation(db),{search:(url.searchParams.get('search')||'').slice(0,200),page:url.searchParams.get('page')}));return true;}
 if(req.method==='POST'){
  permitted(user,['admin','manager']);
  const status=await db.withLocks(['shopify-observation'],async()=>{
   const prior=await readObservation(db);if(prior&&['shopify','erplain'].includes(prior.phase))return 'running';
   if(prior&&Date.now()-Date.parse(prior.updatedAt)<60000)return 'cooldown';
   await save(db,freshObservation());return 'started';
  });json(res,status==='cooldown'?429:202,{status,...(status==='cooldown'?{error:'Veuillez attendre une minute avant une nouvelle lecture.'}:{})});return true;
 }
 json(res,405,{error:'Méthode non autorisée'});return true;
}
