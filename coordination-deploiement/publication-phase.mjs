// Publication receipt is rechecked by the authenticated server bridge.
// A pending recipe remains a FIFO blocker; this is never permission to overtake.
export function publicationReceipt(report){
 const p=report.publication;
 if(p?.status!=='verified'||!/^([a-f0-9]{40})$/.test(p.commit||'')||!/^([a-f0-9]{64})$/.test(p.environmentHash||'')||p.controlsRestored!==true||!p.backup?.startsWith('/var/backups/nextech/')||!p.files||!Object.keys(p.files).length)throw Error('Publication verifiee requise avant recette');
 for(const [name,sha] of Object.entries(p.files))if(!/^(src\/|public\/|package(?:-lock)?\.json$)/.test(name)||name.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||name.includes('\\')||sha!==null&&!/^[a-f0-9]{64}$/.test(sha))throw Error('Empreinte de publication invalide');
 return structuredClone(p);
}
