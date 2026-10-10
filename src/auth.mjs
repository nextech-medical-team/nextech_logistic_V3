import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const tokenHash=s=>createHash('sha256').update(s).digest('hex');
export async function createUser(db,email,password,role){
  email=String(email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Adresse email invalide');
  if(typeof password!=='string'||password.length<12||password.length>256)throw new Error('Mot de passe : 12 à 256 caractères');
  const salt=randomBytes(16).toString('hex'),hash=await scrypt(password,salt,64);
  await db.query('INSERT INTO users(id,email,password,role) VALUES($1,$2,$3,$4)',[randomUUID(),email,salt+':'+hash.toString('hex'),role]);
  return {email,role};
}
export async function login(db,email,password){
  if(typeof password!=='string'||password.length>256)throw new Error('Identifiants incorrects');
  const {rows}=await db.query('SELECT * FROM users WHERE email=$1',[String(email).trim().toLowerCase()]);
  const u=rows[0],salt=u?.password.split(':')[0]||'unavailable';
  const hash=await scrypt(password,salt,64);
  if(!u||!timingSafeEqual(hash,Buffer.from(u.password.split(':')[1],'hex')))throw new Error('Identifiants incorrects');
  const token=randomBytes(32).toString('hex');
  await db.query(`INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')`,[tokenHash(token),u.id]);
  return {token,user:{email:u.email,role:u.role,permissions:u.permissions||[]}};
}
export async function authenticate(db,cookie=''){
  const token=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('v3session='))?.slice(10);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const {rows}=await db.query('SELECT u.id,u.email,u.role,u.permissions FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now()',[tokenHash(token)]);return rows[0]||null;
}
