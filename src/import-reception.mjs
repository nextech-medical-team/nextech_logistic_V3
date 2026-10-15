import {randomUUID,createHash} from 'node:crypto';
import {cancelledImportSql} from './cancelled-import-reimport.mjs';

const ref=x=>String(x??'').trim();
const receptionCanonical=value=>Array.isArray(value)?value.map(receptionCanonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>!['importRows','importApiVerifiedAt','importedAt','importedBy','row','requestId','file','files','filename'].includes(k)).map(k=>[k,receptionCanonical(value[k])])):value;
export const shopIdentity=o=>ref(o.source_payload?.sourceShop||o.source_payload?.shop_domain||o.source_payload?.shop).toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');
const shopifyId=o=>ref(o.source_payload?.id).replace(/^gid:\/\/shopify\/Order\//,'');
export function sameImportIdentity(a,b,channel){
 if(b.channel!==channel)return b.channel==='erplain'&&ref(b.source_reference||b.reference)===ref(a.source_reference||a.reference);
 const aShop=shopIdentity(a),bShop=shopIdentity(b);
 if(aShop&&bShop&&aShop!==bShop)return false;
 if(channel==='shopify'&&shopifyId(a)&&shopifyId(b))return shopifyId(a)===shopifyId(b);
 return ref(a.source_reference||a.reference)===ref(b.source_reference||b.reference);
}
export async function importCandidates(db,orders,channel){
 const refs=[...new Set(orders.map(o=>ref(o.source_reference||o.reference)))],ids=channel==='shopify'?orders.map(shopifyId).filter(Boolean):[];
 return (await db.query(`SELECT id,channel,reference,source_reference,recipient,label_status,erp_status,source_payload,erp_live FROM orders WHERE NOT (${cancelledImportSql}) AND (channel=$1 OR channel='erplain' OR ($1 IN ('tender','samples') AND channel IN ('tender','samples'))) AND (coalesce(source_reference,reference)=ANY($2::text[]) OR reference=ANY($2::text[]) OR ($1='shopify' AND source_payload->>'id'=ANY($3::text[]))) ORDER BY received_at,id`,[channel,refs,ids])).rows;
}
export function matchImport(order,candidates,channel){
 const matches=candidates.filter(o=>sameImportIdentity(order,o,channel));
 const known=matches.filter(o=>o.channel===channel),external=matches.filter(o=>o.channel==='erplain');
 const conflict=channel==='shopify'?candidates.find(o=>o.channel===channel&&ref(o.source_reference||o.reference)===ref(order.source_reference||order.reference)&&(!shopIdentity(o)||!shopIdentity(order)||shopIdentity(o)===shopIdentity(order))):null;
 const cross=['tender','samples'].includes(channel)?candidates.find(o=>['tender','samples'].includes(o.channel)&&o.channel!==channel&&ref(o.source_reference||o.reference)===ref(order.source_reference||order.reference)):null;
 const chosen=known[0]||external[0]||conflict||cross||null;
 const scopeAmbiguous=channel==='shopify'&&chosen&&shopIdentity(chosen)!==shopIdentity(order)&&(!shopIdentity(chosen)||!shopIdentity(order));
 return {existing:chosen,ambiguous:matches.length>1||!!scopeAmbiguous||external.length>0||!!cross||!!conflict&&!matches.includes(conflict)};
}
const initialized=new WeakMap();
export async function initializeImportReceptions(db){
 if(!initialized.has(db))initialized.set(db,db.exec(`CREATE TABLE IF NOT EXISTS order_import_receptions(id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),channel text NOT NULL,source_reference text NOT NULL,order_id text,receipt_id text,filename text NOT NULL,signature text NOT NULL,outcome text NOT NULL,snapshot jsonb NOT NULL);
 CREATE INDEX IF NOT EXISTS order_import_receptions_order ON order_import_receptions(order_id,created_at);
 CREATE INDEX IF NOT EXISTS order_import_receptions_source ON order_import_receptions(channel,source_reference,created_at);`).catch(error=>{initialized.delete(db);throw error;}));
 await initialized.get(db);
}
export async function recordImportReception(tx,order,{channel,filename,receiptId=null,orderId=null,outcome}){
 const snapshot={reference:order.source_reference||order.reference,recipient:order.recipient,address:order.address,source_date:order.source_date,source_payload:order.source_payload,lines:(order.lines||[]).map(l=>({source_sku:l.source_sku,quantity:l.quantity,source_payload:l.source_payload}))};
 const signature=createHash('sha256').update(JSON.stringify(receptionCanonical(snapshot))).digest('hex');
 if(outcome==='duplicate_received'&&orderId){const prior=(await tx.query('SELECT signature FROM order_import_receptions WHERE order_id=$1 AND channel=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[orderId,channel])).rows[0];if(prior&&prior.signature!==signature)outcome='duplicate_changed';}
 await tx.query('INSERT INTO order_import_receptions(id,channel,source_reference,order_id,receipt_id,filename,signature,outcome,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),channel,ref(snapshot.reference),orderId,receiptId,String(filename||'').slice(0,255),signature,outcome,JSON.stringify(snapshot)]);
 return outcome;
}
export async function readImportReceptions(db,{orderId='',reference='',limit=50}={}){
 if(!orderId&&!reference)throw Error('Commande ou référence requise');
 if(typeof orderId!=='string'||typeof reference!=='string'||orderId.length>200||reference.length>500)throw Error('Référence invalide');
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Limite invalide');
 return (await db.query(`SELECT id,created_at,channel,source_reference,order_id,receipt_id,filename,outcome,snapshot FROM order_import_receptions WHERE ($1<>'' AND order_id=$1) OR ($2<>'' AND source_reference=$2) ORDER BY created_at DESC,id DESC LIMIT $3`,[orderId,reference,limit])).rows;
}
