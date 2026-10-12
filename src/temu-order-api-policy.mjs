// Human suspension: TEMU order content comes from files; labels remain API based.
let store=null;
export function configureTemuOrderApiPolicy(db){store=db;}
export const temuOrderApiPauseMessage='TEMU · Import et mise à jour des commandes par API suspendus : utiliser un fichier';
export async function temuOrderApiPaused(){
 if(!store)return false;
 const value=(await store.query("SELECT value FROM settings WHERE key='marketplace_automatic'")).rows[0]?.value;
 if(!value)throw Error('TEMU · Politique des imports indisponible');
 return value.channels?.temu===false;
}
export function pausedTemuOrderApi(){return Object.assign(Error(temuOrderApiPauseMessage),{code:'TEMU_ORDER_API_PAUSED'});}
export async function assertTemuOrderApiRead(type,options={}){
 if(!/^bg\.order\./.test(type))return;
 if(type==='bg.order.detail.v2.get'&&options.purpose==='label')return;
 if(await temuOrderApiPaused())throw pausedTemuOrderApi();
}
