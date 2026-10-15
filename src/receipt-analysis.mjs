import {createHash} from 'node:crypto';

// Only provider reads are cached. Resuming an analysis never replays a write.
export async function receiptAnalysis(api,work,{checkpoint={},save=async()=>{},progress=async()=>{},maxMs=90000,now=Date.now}={}){
 const cache={...checkpoint},started=now();let active=true,timer;
 const alive=()=>{if(!active||now()-started>=maxMs)throw Error('Analyse incomplète : délai de lecture dépassé. Reprendre les lectures manquantes.');};
 const report=async p=>{alive();await progress(p);alive();};
 const reader={verify:async()=>{alive();const r=await api.verify();alive();return r;},request:async(q,v={})=>{
  alive();if(!/^query\s/.test(q))throw Error('Analyse : seules les lectures Erplain sont autorisées');
  const key=createHash('sha256').update(JSON.stringify([q,v])).digest('hex'),prior=cache[key];
  if(prior&&now()-prior.at<120000){await report({phase:'resume',message:'Reprise des lectures déjà obtenues (moins de deux minutes)'});return structuredClone(prior.data);}
  const name=q.match(/^query\s+(\w+)/)?.[1];await report({phase:'provider',operation:name,message:name?.includes('RelatedStock')?'Recherche des commandes liées aux SKU reçus':name?.includes('Document')?'Vérification des BL concernés':'Lecture Erplain en cours'});
  const result=await api.request(q,v);alive();cache[key]={at:now(),data:structuredClone(result)};await save(cache);alive();return result;
 }};
 try{return await Promise.race([work(reader,report),new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('Analyse incomplète : délai de lecture de 90 secondes dépassé. Reprendre les lectures manquantes.'));},maxMs);})]);}
 finally{active=false;clearTimeout(timer);}
}
