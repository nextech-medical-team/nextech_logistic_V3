export function assertLiveCapacity(current,planned,limit=null){
 if(!Number.isInteger(current)||current<0||!Number.isInteger(planned)||planned<0)throw new Error('Capacité Erplain LIVE non vérifiable : création bloquée');
 if(limit!==null&&(!Number.isInteger(limit)||limit<0))throw new Error('Limite Erplain LIVE invalide');
 if(limit!==null&&current+planned>limit)throw new Error(`Limite Erplain LIVE : ${current} commandes existantes + ${planned} nouveaux BC dépasseraient ${limit}. Création bloquée.`);
 return {current,planned,limit,remaining:limit===null?null:limit-current};
}
