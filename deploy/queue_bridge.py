#!/usr/bin/python3
"""Authenticated local Section 7 bridge. The GitHub key cannot call this endpoint."""
import os,sys,json,re,tempfile,time,datetime
from pathlib import Path
STATE=Path('/var/lib/nextech-cicd')
def sync(payload):
 if payload.get('version')!=1 or not isinstance(payload.get('requests'),list):raise ValueError('Snapshot invalide')
 rows=payload['requests']
 for row in rows:
  if not re.fullmatch('[a-f0-9-]{36}',row.get('id','')) or row.get('status') not in ('ready','deploying','blocked'):raise ValueError('Demande invalide')
  if not isinstance(row.get('createdAt'),str) or not row.get('createdAt'):raise ValueError('Date absente')
  if datetime.datetime.fromisoformat(row['createdAt'].replace('Z','+00:00')).tzinfo is None:raise ValueError('Date UTC requise')
 old=json.loads((STATE/'local-queue.json').read_text()) if (STATE/'local-queue.json').exists() else {'revision':-1}
 if payload.get('revision',-1)<old['revision']:raise ValueError('Snapshot plus ancien refusé')
 target=STATE/'local-queue.json';temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(payload));temporary.chmod(0o600);os.replace(temporary,target)
 automatic=[]
 for file in (STATE/'requests').glob('*.json'):
  record=json.loads(file.read_text());report=STATE/'reports'/('deploy-'+record['commit']+'.json')
  if report.exists():
   record['report']=json.loads(report.read_text())
   if record['status']=='deploying' and record['report']['status'] in ('deployed','failed','superseded'):
    record['status']=record['report']['status'];file.write_text(json.dumps(record));file.chmod(0o600)
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
