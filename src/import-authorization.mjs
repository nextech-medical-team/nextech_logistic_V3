import {randomBytes,createHash,scrypt as rawScrypt,timingSafeEqual} from 'node:crypto';import {promisify} from 'node:util';
const scrypt=promisify(rawScrypt),hash=s=>createHash('sha256').update(s).digest('hex');
const signature=b=>hash(JSON.stringify([b.kind,b.filename,b.content,b.requestId]));
export function importAuthorization(db,{now=Date.now}={}){
const approvals=new Map(),failures=new Map();
return {async authorize(user,b){
 const recent=failures.get(user.id);if(recent&&recent.until>now()&&recent.count>=5)throw Error('Trop de tentatives. Réessayez dans quinze minutes.');
 const record=(await db.query('SELECT id,email,password FROM users WHERE id=$1',[user.id])).rows[0];
 const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(password.length>256)throw Error('Identifiants incorrects');
 const [salt,encoded]=String(record?.password||'').split(':');const digest=await scrypt(password,salt||'unavailable',64);const valid=record&&email===record.email&&encoded&&encoded.length===128&&timingSafeEqual(digest,Buffer.from(encoded,'hex'));
 if(!valid){failures.set(user.id,{count:recent?.until>now()?recent.count+1:1,until:now()+15*60000});throw Error('Identifiants incorrects : utilisez votre compte connecté.');}
 if(!b.requestId||!b.content||!b.filename)throw Error('Analysez le fichier avant confirmation');
 failures.delete(user.id);for(const [key,v]of approvals)if(v.until<=now())approvals.delete(key);
 const token=randomBytes(32).toString('hex');approvals.set(hash(token),{userId:user.id,signature:signature(b),until:now()+5*60000});return {token};
 },assert(user,b){if(b.selectionMode!=='all'&&!b.duplicateSelection?.length)return;const approval=approvals.get(hash(String(b.importAuthorization||'')));if(!approval||approval.until<=now()||approval.userId!==user.id||approval.signature!==signature(b))throw Error('Confirmation requise : saisissez vos identifiants avant de réimporter des commandes existantes.');}};
}
