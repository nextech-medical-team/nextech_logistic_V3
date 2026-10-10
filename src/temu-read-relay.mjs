import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export function relayConfig(){
 try{return JSON.parse(readFileSync(process.env.DATA_DIR?join(process.env.DATA_DIR,'temu-read-relay.json'):new URL('../data/temu-read-relay.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));}
 catch(e){if(e.code==='ENOENT'&&process.env.TEMU_RELAY_REQUIRED!=='1')return null;throw new Error('Configuration du relais TEMU absente ou illisible');}
}
export async function readThroughRelay(config,payload,{spawnImpl=spawn}={}){
 if(config.host!=='135.125.79.68'||config.user!=='ubuntu'||!config.identityFile||!config.knownHostsFile)throw new Error('Configuration du relais TEMU invalide');
 const permanent=config.permanent===true&&config.expiresAt===null;
 if(!permanent&&(!Number.isFinite(Date.parse(config.expiresAt))||Date.now()>=Date.parse(config.expiresAt)))throw new Error('TEMU · Accès temporaire au relais expiré');
 return new Promise((resolve,reject)=>{
  const args=['-T','-i',config.identityFile,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile="'+config.knownHostsFile.replaceAll('\\','/')+'"',config.user+'@'+config.host,'temu-readonly'];
  const child=spawnImpl(process.platform==='win32'?'C:/Windows/System32/OpenSSH/ssh.exe':'ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output=[],size=0,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(new Error('TEMU · Relais sans réponse après 45 secondes'));},45000);
  child.on('error',()=>finish(new Error('TEMU · Connexion au relais impossible')));
  child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{size+=b.length;if(size>8388608){child.kill();finish(new Error('TEMU · Réponse trop volumineuse'));}else output.push(b);});
  child.stderr.on('data',()=>{});
  child.on('close',code=>{if(code!==0)return finish(new Error('TEMU · Relais inaccessible ou requête refusée (SSH '+code+')'));try{finish(null,JSON.parse(Buffer.concat(output).toString('utf8')));}catch{finish(new Error('TEMU · Réponse du relais invalide'));}});
  child.stdin.end(JSON.stringify(payload));
 });
}
