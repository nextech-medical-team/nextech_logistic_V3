import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function validatePublicationReadiness(root,m){
 if(m.ready!==true)throw Error('Publication refusée : manifeste non prêt (ready doit être true).');
 if(!Array.isArray(m.openGates)||m.openGates.length)throw Error('Publication refusée : contrôles ou blocages encore ouverts.');
 if(!m.git?.pushVerified||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(m.git.commit||''))throw Error('Publication refusée : commit Git distant non vérifié.');
 if(m.verification?.status!=='PASS'||m.verification.commit!==m.git.commit)throw Error('Publication refusée : vérifications absentes ou liées à un autre commit.');
 for(const key of ['functional','serverBaseline','performance','visualDesktop','visualMobile']){
  const check=m.verification[key];
  if(check?.status==='NOT_APPLICABLE'&&check.reason)continue;
  if(check?.status!=='PASS'||!check.proofPath||!check.sha256)throw Error('Publication refusée : preuve manquante pour '+key+'.');
  const absolute=path.resolve(root,check.proofPath),rel=path.relative(root,absolute);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Preuve hors projet');
  const hash=createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  if(hash!==check.sha256)throw Error('Publication refusée : preuve modifiée pour '+key+'.');
 }
 for(const f of m.files){
  const absolute=path.resolve(root,f.preparedPath),rel=path.relative(root,absolute);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Fichier préparé hors projet');
  if(createHash('sha256').update(await fs.readFile(absolute)).digest('hex')!==f.preparedSha256)throw Error('Publication refusée : fichier préparé changé depuis validation : '+f.serverPath);
 }
}
