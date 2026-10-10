import fs from 'node:fs/promises';import path from 'node:path';import{spawnSync}from'node:child_process';
export async function mirrorQueue(root,docs){
 const configPath=path.join(root,'.local-acces-v3','cicd-bridge.json');let config;
 try{config=JSON.parse(await fs.readFile(configPath,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(!config.enabled)return;
 const replacementIds=new Set();
 for(const doc of docs)if(doc.status==='deployed'){
  try{const m=JSON.parse(await fs.readFile(path.resolve(root,doc.manifest),'utf8'));for(const id of m.replaces||[])replacementIds.add(id);}catch{}
 }
 const resolutions=config.certifiedResolutions||{};
 for(const [id,by]of Object.entries(resolutions))if(docs.some(d=>d.id===by&&d.status==='deployed'))replacementIds.add(id);
 const rows=[];
 for(const doc of docs){
  if(doc.serverManaged)continue;
  let requires=doc.requiresReplacement===true;
  for(const report of doc.reports||[]){try{if(JSON.parse(await fs.readFile(path.resolve(root,report.path),'utf8')).requiresReplacement)requires=true;}catch{}}
  if(!['ready','deploying','blocked'].includes(doc.status)&&!(doc.status==='failed'&&requires&&!replacementIds.has(doc.id)))continue;
  let m={};try{m=JSON.parse(await fs.readFile(path.resolve(root,doc.manifest),'utf8'));}catch{}
  rows.push({id:doc.id,createdAt:doc.createdAt,status:doc.status==='failed'?'blocked':doc.status,section:doc.section,gates:{ready:m.ready===true,openGates:m.openGates||[],commit:m.git?.commit||null,verification:m.verification?.status||null}});
 }
 const revision=Date.now();
 const result=spawnSync(config.python,[config.script],{cwd:root,input:JSON.stringify({version:1,revision,requests:rows}),encoding:'utf8',timeout:120000});
 if(result.status!==0)throw Error('Synchronisation serveur de la file impossible ; mutation locale refusée.');
 const reply=JSON.parse(result.stdout);if(reply.status!=='PASS')throw Error('Synchronisation refusée');
 const reportDir=path.join(root,'coordination-deploiement','cicd-rapports');await fs.mkdir(reportDir,{recursive:true});
 for(const record of reply.automaticRequests||[]){
  if(!/^[a-f0-9-]{36}$/.test(record.id)||!/^[a-f0-9]{40}$/.test(record.commit))throw Error('Rapport serveur invalide');
  const reportPath=path.join(reportDir,record.commit+'.json');await fs.writeFile(reportPath,JSON.stringify(record,null,2)+'\n');
  const local={id:record.id,section:7,summary:'Publication automatique Git '+record.commit.slice(0,12),createdAt:record.createdAt,status:record.status,serverManaged:true,commit:record.commit,reports:[{at:record.updatedAt||record.createdAt,status:record.status,path:path.relative(root,reportPath)}]};
  await fs.writeFile(path.join(root,'coordination-deploiement','requests',record.id+'.json'),JSON.stringify(local,null,2)+'\n');
 }
}
