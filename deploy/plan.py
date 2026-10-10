"""Pure deployment planner. Production drift and private export differences fail closed."""
import hashlib,re

RUNTIME=re.compile(r'^(?:src/|public/|package(?:-lock)?\.json$)')
def digest(data):return hashlib.sha256(data).hexdigest()
def normalized(data):return digest(data.replace(b'\r\n',b'\n'))
def safe_path(name):
 return bool(RUNTIME.match(name)) and not any(p in ('','..','.') or p.startswith('.') for p in name.split('/')) and not name.startswith('/') and '\\' not in name and not name.endswith(('.pem','.key','.env','.credential.clixml'))

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
