#!/usr/bin/python3
"""Authenticated local Section 7 bridge. The GitHub key cannot call this endpoint."""
import os,sys,json,re,tempfile,time,datetime
from pathlib import Path
STATE=Path('/var/lib/nextech-cicd')
def restoration_certificate(record):
 # The local caller cannot assert a successful rollback: recheck it on the server.
 from dispatcher import read_current,verify_environment,health,guard,digest
 report=record.get('report',{})
 baseline=json.loads((STATE/'baseline.json').read_text())
 expected_commit=report.get('baselineCommitBefore') or baseline['commit']
 if baseline['commit']!=expected_commit:raise ValueError('Référence publiée différente ; rapprochement Section7 nécessaire')
 expected={f['path']:f['before'] for f in report.get('files',[])} or baseline['serverHashes']
 actual=read_current(expected.keys())
 for name,sha in expected.items():
  if (digest(actual[name]) if name in actual else None)!=sha:raise ValueError('Restauration non prouvée : '+name)
 environment=report.get('environmentHashBefore') or baseline.get('environmentHash')
 if not environment or verify_environment()!=environment:raise ValueError('Environnement non restauré')
 health()
 if report.get('paused') or report.get('taskControlsRestored') is False:
  guard('verify-restored',Path(report['backup']))
 return {'verified':True,'previousCommit':expected_commit,'fileHashes':expected,'services':['active','active'],'http':200,'environmentPreserved':True,'controlsRestored':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}

def sync(payload):
 if payload.get('version')!=1 or not isinstance(payload.get('requests'),list):raise ValueError('Snapshot invalide')
 rows=payload['requests']
 for row in rows:
  if not re.fullmatch('[a-f0-9-]{36}',row.get('id','')) or row.get('status') not in ('ready','deploying','blocked'):raise ValueError('Demande invalide')
  if not isinstance(row.get('createdAt'),str) or not row.get('createdAt'):raise ValueError('Date absente')
  if datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00')).tzinfo is None:raise ValueError('Date UTC requise')
 old=json.loads((STATE/'local-queue.json').read_text()) if (STATE/'local-queue.json').exists() else {'revision':-1}
 if payload.get('revision',-1)<old['revision']:raise ValueError('Snapshot plus ancien refusé')
 resolutions=[]
 for identifier in payload.get('resolveAutomatic',[]):
  if not re.fullmatch('[a-f0-9-]{36}',identifier):raise ValueError('Résolution invalide')
  matches=[p for p in (STATE/'requests').glob('*.json') if json.loads(p.read_text()).get('id')==identifier]
  if len(matches)!=1:raise ValueError('Demande automatique inconnue')
  record=json.loads(matches[0].read_text())
  if record['status']=='resolved' and record.get('resolution',{}).get('verified') is True:continue
  if record['status'] not in ('failed','blocked'):raise ValueError('Échec à résoudre absent')
  report_path=STATE/'reports'/('deploy-'+record['commit']+'.json')
  if report_path.exists():record['report']=json.loads(report_path.read_text())
  certificate=restoration_certificate(record);resolutions.append((matches[0],record,certificate))
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
