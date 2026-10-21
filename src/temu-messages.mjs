import {connectTemuShops,loadTemuShopConfig} from './temu-shop-clients.mjs';
import {loadShopVault} from './temu-shop-vault.mjs';

// No customer-conversation API has been verified. Never substitute orders,
// cancellation events, read receipts or email for customer messages.
export const messageAccess={code:'TEMU_MESSAGES_API_UNVERIFIED',available:false,
 reason:'Accès aux conversations clients non vérifié : aucun endpoint, schéma de conversation, statut de réponse et permission correspondante confirmés dans la documentation officielle accessible. Une connexion boutique valide ne prouve pas cet accès.',
 documentation:'https://partner-eu.temu.com/'};

export async function initializeTemuMessages(db){
 await db.exec(`CREATE TABLE IF NOT EXISTS temu_message_conversations (
  shop_id TEXT NOT NULL, conversation_id TEXT NOT NULL, country TEXT,
  customer TEXT, last_customer_at TIMESTAMPTZ NOT NULL,
  reply_status TEXT NOT NULL DEFAULT 'unknown' CHECK(reply_status IN ('answered','unanswered','unknown')),
  content JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(shop_id,conversation_id));
 CREATE INDEX IF NOT EXISTS temu_messages_latest ON temu_message_conversations(last_customer_at DESC,shop_id,conversation_id);
 CREATE TABLE IF NOT EXISTS temu_message_checks (
  id INTEGER PRIMARY KEY CHECK(id=1), checked_at TIMESTAMPTZ, coverage JSONB NOT NULL DEFAULT '[]');`);
}

// Internal V3 contract for a future documented adapter, NOT Temu API fields.
// This writer is deliberately not exposed by any HTTP route or active collector.
export async function storeTemuConversation(db,row){
 if(!row.shopId||!row.conversationId||!Number.isFinite(Date.parse(row.lastCustomerAt)))throw Error('Conversation invalide');
 const country=String(row.country||'').toUpperCase();
 if(country&&!/^[A-Z]{2}$/.test(country))throw Error('Pays boutique invalide');
 const status=row.replyEvidence==='reply_to_last_customer_message'&&typeof row.answered==='boolean'?(row.answered?'answered':'unanswered'):'unknown';
 await db.query(`INSERT INTO temu_message_conversations(shop_id,conversation_id,country,customer,last_customer_at,reply_status,content)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(shop_id,conversation_id) DO UPDATE SET
 country=excluded.country,customer=excluded.customer,last_customer_at=excluded.last_customer_at,
 reply_status=excluded.reply_status,content=excluded.content,updated_at=now()
 WHERE excluded.last_customer_at>=temu_message_conversations.last_customer_at`,
 [String(row.shopId),String(row.conversationId),country||null,row.customer||null,row.lastCustomerAt,status,row.content==null?null:JSON.stringify(row.content)]);
}

export function temuMessagesService(db,directory,{connect=connectTemuShops,configLoader=loadTemuShopConfig,shopLoader=loadShopVault,now=()=>new Date()}={}){
 let pending=null,nextCheck=0;
 async function countries(){
  const values=new Set();let configurationAvailable=true;
  try{const c=await configLoader(directory);for(const v of Object.values(c.TEMU_COUNTRIES||{}))values.add(String(v).toUpperCase());}catch{configurationAvailable=false;}
  try{for(const s of await shopLoader(directory))values.add(String(s.country).toUpperCase());}catch{configurationAvailable=false;}
  return {countries:[...values].filter(v=>/^[A-Z]{2}$/.test(v)).sort(),configurationAvailable};
 }
 async function list(params=new URLSearchParams()){
  const country=params.get('country')||'',status=params.get('response')||'',sort=params.get('sort')||'latest';
  if(country&&!/^[A-Z]{2}$/.test(country)||!['','answered','unanswered','unknown'].includes(status)||!['latest','country'].includes(sort))throw Object.assign(Error('Filtres invalides'),{status:400});
  const requested=Number(params.get('page')||1),pageSize=25;
  if(!Number.isSafeInteger(requested)||requested<1)throw Object.assign(Error('Page invalide'),{status:400});
  const args=[country,status],where="WHERE ($1='' OR country=$1) AND ($2='' OR reply_status=$2)";
  const result=await db.readTransaction(async tx=>{
   const counts=(await tx.query(`SELECT count(*) FILTER (WHERE reply_status='unanswered') unanswered,
    count(*) FILTER (WHERE reply_status='unknown') unknown
    FROM temu_message_conversations WHERE ($1='' OR country=$1)`,[country])).rows[0];
   const statistics={unanswered:Number(counts.unanswered),unknown:Number(counts.unknown),available:messageAccess.available,scope:'country'};
   const total=Number((await tx.query(`SELECT count(*) n FROM temu_message_conversations ${where}`,args)).rows[0].n);
   const pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(requested,pages);
   const rows=(await tx.query(`SELECT shop_id,conversation_id,country,customer,last_customer_at,reply_status,content IS NOT NULL has_content FROM temu_message_conversations ${where} ORDER BY ${sort==='country'?'country ASC NULLS LAST,':''}last_customer_at DESC,shop_id,conversation_id LIMIT $3 OFFSET $4`,[...args,pageSize,(page-1)*pageSize])).rows;
   return {rows,total,page,pages,pageSize,statistics};
  });
  const check=(await db.query('SELECT checked_at,coverage FROM temu_message_checks WHERE id=1')).rows[0];
  const known=await countries();
  const stored=(await db.query('SELECT DISTINCT country FROM temu_message_conversations WHERE country IS NOT NULL')).rows.map(r=>r.country);
  return {...result,...known,countries:[...new Set([...known.countries,...stored])].sort(),access:messageAccess,lastSyncAt:null,lastCheckAt:check?.checked_at||null,coverage:check?.coverage||[],running:!!pending};
 }
 async function checkConnections(){
  const coverage=[];
  try{
   const c=await connect(directory,{allowUnavailableApplications:true});
   for(const shopId of c.clients.keys())coverage.push({shopId,country:c.countryByMall.get(shopId)||c.config.TEMU_COUNTRIES?.[shopId]||null,connection:'verified',messages:'unverified'});
   for(const [country] of c.connectionErrors)coverage.push({country,connection:'error',messages:'unverified',error:'Autorisation boutique non vérifiée ; consulter les connexions Temu.'});
  }catch{coverage.push({connection:'error',messages:'unverified',error:'Configuration privée ou connexion Temu indisponible ; consulter les connexions Temu.'});}
  await db.query(`INSERT INTO temu_message_checks(id,checked_at,coverage) VALUES(1,$1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,coverage=excluded.coverage`,[now().toISOString(),JSON.stringify(coverage)]);
  return {access:messageAccess,coverage,lastSyncAt:null};
 }
 async function refresh(){
  if(pending)return pending;
  if(Date.now()<nextCheck)return {access:messageAccess,lastSyncAt:null,throttled:true};
  nextCheck=Date.now()+60000;
  pending=checkConnections();try{return await pending;}finally{pending=null;}
 }
 async function routes({p,req,res,url,user,json,permitted}){
  if(!p.startsWith('/api/temu/messages'))return false;
  // Match V3: authenticated users can consult; operational roles refresh.
  if(p==='/api/temu/messages'&&req.method==='GET'){json(res,200,await list(url.searchParams));return true;}
  if(p==='/api/temu/messages/refresh'&&req.method==='POST'){
   permitted(user,['admin','manager','operator']);const result=await refresh();json(res,409,{...result,error:messageAccess.reason});return true;
  }
  if(p==='/api/temu/messages/conversation'&&req.method==='GET'){
   const row=(await db.query('SELECT shop_id,conversation_id,country,customer,content FROM temu_message_conversations WHERE shop_id=$1 AND conversation_id=$2',[url.searchParams.get('shop'),url.searchParams.get('id')])).rows[0];
   if(!row||row.content==null){json(res,404,{error:'Contenu de conversation indisponible'});return true;}
   json(res,200,row);return true;
  }
  json(res,405,{error:'Action non disponible'});return true;
 }
 return {list,refresh,routes};
}
