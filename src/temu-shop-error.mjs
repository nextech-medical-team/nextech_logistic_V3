export const unavailableTemuApplication=error=>String(error?.code)==='4000000'&&(error?.temuApplicationUnavailable===true||/application information query is abnormal/i.test(String(error?.message||'')));
export function temuShopError(error,scope,secrets=[]){
 if(error?.code==='TEMU_STOPPING')return error;
 let message=String(error?.message||error);
 for(const secret of secrets.filter(v=>typeof v==='string'&&v.length).sort((a,b)=>b.length-a.length))message=message.replaceAll(secret,'[masqué]');
 const hint=String(error?.code)==='4000000'?' Vérifiez la clé d’application, son secret et l’autorisation du jeton de cet accès dans la configuration TEMU.':'';
 return Object.assign(new Error('TEMU · '+scope+' : '+message+hint,{cause:error}),error,{temuApplicationUnavailable:unavailableTemuApplication(error),message:'TEMU · '+scope+' : '+message+hint});
}
