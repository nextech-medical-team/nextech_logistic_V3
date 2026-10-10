const infrastructure=new Set(['dispatcher.py','plan.py','runtime-guard.mjs','ssh-entry.sh'].map(n=>'/usr/local/lib/nextech-cicd/'+n));
export function allowedPublicationPath(type,name){
 if(type==='infrastructure-cicd')return infrastructure.has(name);
 return /^(src|public)\/[\w./-]+$/.test(name)&&!name.split('/').includes('..');
}
