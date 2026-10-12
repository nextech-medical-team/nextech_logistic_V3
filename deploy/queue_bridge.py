#!/usr/bin/python3
"""Authenticated local Section 7 bridge. The GitHub key cannot call this endpoint."""
import os,sys,json,re,tempfile,time,datetime
from pathlib import Path,PurePosixPath
STATE=Path('/var/lib/nextech-cicd')

def safe_preinstall_failure(record):
 report=record.get('report',{})
 return record.get('status')=='failed' and report.get('installed') is False and report.get('paused') is False and not report.get('manualIntervention') and report.get('rollback')!='FAILED' and report.get('taskControlsRestored') is not False

def later_baseline_allowed(record,baseline,is_ancestor):
 report=record.get('report',{})
 previous=report.get('baselineCommitBefore')
 current=baseline.get('commit')
 if not previous or not current or previous==current:return False
 # Only a pre-install, pre-pause failure can be certified against a newer publication.
 if report.get('installed') is not False or report.get('paused') is not False:return False
 if report.get('manualIntervention') or report.get('rollback')=='FAILED' or report.get('taskControlsRestored') is False:return False
 return bool(baseline.get('serverHashes')) and is_ancestor(previous,current)

def restoration_certificate(record):
 # The local caller cannot assert a successful rollback: recheck it on the server.
 from dispatcher import read_current,verify_environment,health,guard,digest,git
 report=record.get('report',{})
 baseline=json.loads((STATE/'baseline.json').read_text())
 expected_commit=report.get('baselineCommitBefore') or baseline['commit']
 later=False
 if baseline['commit']!=expected_commit:
  def ancestor(before,after):
   try:git('merge-base','--is-ancestor',before,after);return True
   except Exception:return False
  if not later_baseline_allowed(record,baseline,ancestor):raise ValueError('Référence publiée différente ; rapprochement Section7 nécessaire')
  later=True;expected_commit=baseline['commit']
 expected=baseline['serverHashes'] if later else ({f['path']:f['before'] for f in report.get('files',[])} or baseline['serverHashes'])
 actual=read_current(expected.keys())
 for name,sha in expected.items():
  if (digest(actual[name]) if name in actual else None)!=sha:raise ValueError('Restauration non prouvée : '+name)
 environment=baseline.get('environmentHash') if later else (report.get('environmentHashBefore') or baseline.get('environmentHash'))
 if not environment or verify_environment()!=environment:raise ValueError('Environnement non restauré')
 health()
 if report.get('paused') or report.get('taskControlsRestored') is False:
  guard('verify-restored',Path(report['backup']))
 return {'verified':True,'previousCommit':expected_commit,'fileHashes':expected,'services':['active','active'],'http':200,'environmentPreserved':True,'controlsRestored':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}

def publication_certificate(row):
 from dispatcher import read_current,verify_environment,health,guard,digest
 from plan import safe_path
 p=row.get('publication',{})
 if p.get('status')!='verified' or not re.fullmatch('[a-f0-9]{40}',p.get('commit','')) or not re.fullmatch('[a-f0-9]{64}',p.get('environmentHash','')) or p.get('controlsRestored') is not True:raise ValueError('Publication non verifiee')
 backup_name=p.get('backup','');posix=PurePosixPath(backup_name);backup=Path(backup_name)
 backup_root=Path('/var/backups/nextech').resolve()
 if not posix.is_absolute() or '..' in posix.parts or '\\' in backup_name or backup.resolve()==backup_root or not backup.resolve().is_relative_to(backup_root):raise ValueError('Sauvegarde de publication invalide')
 files=p.get('files')
 if not isinstance(files,dict) or not files or any(not safe_path(n) or (sha is not None and not re.fullmatch('[a-f0-9]{64}',sha)) for n,sha in files.items()):raise ValueError('Empreintes de publication invalides')
 baseline=json.loads((STATE/'baseline.json').read_text())
 if baseline.get('commit')!=p['commit']:raise ValueError('Commit installe different')
 actual=read_current(files)
 for n,sha in files.items():
  if (digest(actual[n]) if n in actual else None)!=sha:raise ValueError('Publication divergente : '+n)
 if verify_environment()!=p['environmentHash']:raise ValueError('Environnement divergent')
 health();guard('verify-restored',backup)
 return True

def sync(payload):
 if payload.get('version')!=1 or not isinstance(payload.get('requests'),list):raise ValueError('Snapshot invalide')
 rows=payload['requests']
 for row in rows:
  if not re.fullmatch('[a-f0-9-]{36}',row.get('id','')) or row.get('status') not in ('ready','deploying','blocked','recipe_pending'):raise ValueError('Demande invalide')
  if not isinstance(row.get('createdAt'),str) or not row.get('createdAt'):raise ValueError('Date absente')
  if datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00')).tzinfo is None:raise ValueError('Date UTC requise')
 old=json.loads((STATE/'local-queue.json').read_text()) if (STATE/'local-queue.json').exists() else {'revision':-1}
 if payload.get('revision',-1)<old['revision']:raise ValueError('Snapshot plus ancien refusé')
 for row in rows:
  if row['status']!='recipe_pending':continue
  previous=next((r for r in old.get('requests',[]) if r['id']==row['id']),{})
  if previous.get('status')!='recipe_pending' or previous.get('publication')!=row.get('publication') or previous.get('publicationCertificate',{}).get('verified') is not True:
   publication_certificate(row)
  row['publicationCertificate']={'verified':True}

 resolutions=[]
 explicit=set(payload.get('resolveAutomatic',[]))
 identifiers=list(explicit)
 if payload.get('resolvePreinstallFailures') is True:
  for file in sorted((STATE/'requests').glob('*.json')):
   candidate=json.loads(file.read_text())
   report=STATE/'reports'/('deploy-'+candidate.get('commit','')+'.json')
   if report.exists():candidate['report']=json.loads(report.read_text())
   if safe_preinstall_failure(candidate) and candidate['id'] not in explicit:identifiers.append(candidate['id'])
 for identifier in identifiers:
  if not re.fullmatch('[a-f0-9-]{36}',identifier):raise ValueError('Résolution invalide')
  matches=[p for p in (STATE/'requests').glob('*.json') if json.loads(p.read_text()).get('id')==identifier]
  if len(matches)!=1:raise ValueError('Demande automatique inconnue')
  record=json.loads(matches[0].read_text())
  if record['status']=='resolved' and record.get('resolution',{}).get('verified') is True:continue
  if record['status'] not in ('failed','blocked'):raise ValueError('Échec à résoudre absent')
  report_path=STATE/'reports'/('deploy-'+record['commit']+'.json')
  if report_path.exists():record['report']=json.loads(report_path.read_text())
  try:certificate=restoration_certificate(record)
  except Exception:
   if identifier in explicit:raise
   continue # No proof means no resolution; preserve the failed blocker.
  resolutions.append((matches[0],record,certificate))
 target=STATE/'local-queue.json';temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(payload));temporary.chmod(0o600);os.replace(temporary,target)
 for file,record,certificate in resolutions:
  record['status']='resolved';record['requiresReplacement']=False;record['resolution']=certificate
  file.write_text(json.dumps(record));file.chmod(0o600)
 automatic=[]
 for file in (STATE/'requests').glob('*.json'):
  record=json.loads(file.read_text());report=STATE/'reports'/('deploy-'+record['commit']+'.json')
  if report.exists():
   record['report']=json.loads(report.read_text())
   if record['status']=='deploying' and record['report']['status'] in ('deployed','failed','superseded'):
    record['status']=record['report']['status'];record['requiresReplacement']=record['status']=='failed';file.write_text(json.dumps(record));file.chmod(0o600)
  automatic.append(record)
 return {'status':'PASS','automaticRequests':automatic}
if __name__=='__main__':
 import fcntl
 if os.geteuid()!=0:sys.exit(64)
 payload=json.loads(sys.stdin.buffer.read(1024*1024+1))
 with open('/var/lock/nextech-deploy.lock','a') as lock:
  deadline=time.monotonic()+60
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if time.monotonic()>deadline:sys.exit('Publication en cours ; nouvelle demande locale à réessayer')
    time.sleep(2)
  print(json.dumps(sync(payload)))
