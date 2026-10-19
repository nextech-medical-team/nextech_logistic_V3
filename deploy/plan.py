"""Pure deployment planner. Production drift and private export differences fail closed."""
import hashlib,re,subprocess,tempfile
from pathlib import Path

RUNTIME=re.compile(r'^(?:src/|public/|package(?:-lock)?\.json$)')
def digest(data):return hashlib.sha256(data).hexdigest()
def normalized(data):return digest(data.replace(b'\r\n',b'\n'))
def safe_path(name):
 return bool(RUNTIME.match(name)) and not any(p in ('','..','.') or p.startswith('.') for p in name.split('/')) and not name.startswith('/') and '\\' not in name and not name.endswith(('.pem','.key','.env','.credential.clixml'))

def reconcile_overlay_sources(old,new,current,baseline,read_source):
 """Accept only recorded Git overlays fully preserved by the candidate.

 No baseline, production bytes or business state are changed here. A three-way
 merge must reproduce the candidate exactly; conflicts and lost fixes fail closed.
 """
 result=dict(old);verified=[]
 overlays=baseline.get('reconciliation',{}).get('preservedOverlays',{})
 for name,record in overlays.items():
  if old.get(name)==new.get(name) or current.get(name)==old.get(name):continue
  if not safe_path(name) or name not in old or name not in new:raise ValueError('Rapprochement overlay invalide : '+name)
  commit=record.get('sourceCommit','');expected=record.get('sha256')
  if not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('Commit overlay invalide : '+name)
  actual=current.get(name)
  if actual is None or digest(actual)!=expected or baseline['serverHashes'].get(name)!=expected:raise ValueError('Conflit serveur overlay : '+name)
  source=read_source(commit,name)
  if digest(source)!=expected:raise ValueError('Source Git overlay divergente : '+name)
  with tempfile.TemporaryDirectory(prefix='nextech-overlay-') as folder:
   paths=[Path(folder)/label for label in ('candidate','base','overlay')]
   # Semicolon/braces separate changes in compact JavaScript lines. This is a
   # byte comparison only; no candidate code is executed or rewritten.
   def comparison(data):
    data=data.replace(b'\r\n',b'\n')
    for delimiter in (b';',b'{',b'}'):data=data.replace(delimiter,delimiter+b'\n')
    return data
   for path,data in zip(paths,(new[name],old[name],source)):path.write_bytes(comparison(data))
   merged=subprocess.run(['git','merge-file','-p',*[str(p) for p in paths]],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if merged.returncode!=0 or merged.stdout!=comparison(new[name]):raise ValueError('Correctif serveur non preserve par la cible : '+name)
  result[name]=source;verified.append({'path':name,'sourceCommit':commit,'sha256':expected,'candidatePreservesOverlay':True})
 return result,verified

def plan(old,new,current,baseline):
 changes=[]
 for name in sorted(set(old)|set(new)):
  if old.get(name)==new.get(name):continue
  if not safe_path(name):raise ValueError('Chemin de publication refusé : '+name)
  actual=current.get(name)
  actual_hash=digest(actual) if actual is not None else None
  if actual_hash!=baseline.get(name):raise ValueError('Conflit serveur : '+name)
  if name in old and (actual is None or normalized(actual)!=normalized(old[name])):
   raise ValueError('Source privée ou divergente : '+name+' ; rapprochement Section 7 nécessaire')
  if name not in old and actual is not None:raise ValueError('Fichier serveur non suivi déjà présent : '+name)
  changes.append({'path':name,'before':actual_hash,'after':digest(new[name]) if name in new else None})
 return changes
