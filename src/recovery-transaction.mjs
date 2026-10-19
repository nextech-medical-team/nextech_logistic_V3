// The callback must contain database work only. Provider calls stay outside it.
export async function recoveryTransaction(db,callback,{pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let attempt=0;;attempt++){
  try{return await db.transaction(callback);}
  catch(error){if(!['40P01','40001'].includes(error?.code)||attempt>=2)throw error;await pause(25*(attempt+1));}
 }
}
