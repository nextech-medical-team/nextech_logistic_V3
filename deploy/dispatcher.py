#!/usr/bin/python3
"""Section 7 publisher, installed once by Section 7; never run candidate code as root."""
import os,sys,json,time,shutil,subprocess,tempfile,re,urllib.request,signal,base64,uuid,datetime
try:import grp
except ImportError:
 import types
 grp=types.SimpleNamespace(getgrnam=lambda _:None) # Windows unit tests only; publisher requires Linux/root.
from pathlib import Path
from plan import plan,digest,safe_path
from queue_policy import blockers,validate_manifest,apply_human_priority

STATE=Path('/var/lib/nextech-cicd')
APP=Path('/opt/nextech/current')
REPO=STATE/'repository'
REMOTE='https://github.com/nextech-medical-team/nextech_logistic_V3.git'
GUARD='/usr/local/lib/nextech-cicd/runtime-guard.mjs'
RUNUSER='/usr/sbin/runuser'
BUILD_ROOT='/var/tmp'
SERVICES=['nextech-web','nextech-worker']

def run(args,**kwargs):
 return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs).stdout
def git(*args):return run(['git','-c','safe.directory='+str(REPO),'-C',str(REPO),*args])
def tree(commit):
 entries=git('ls-tree','-r',commit).decode().splitlines();names=[]
 for entry in entries:
  metadata,name=entry.split('\t',1)
  if safe_path(name):
   if metadata.split()[0] not in ('100644','100755'):raise ValueError('Type Git refusé : '+name)
   names.append(name)
 return {n:git('show',commit+':'+n) for n in names if safe_path(n)}
def read_current(names):
 result={}
 for name in names:
  target=APP/name
  # Never traverse an application symlink into business data or /etc.
  if target.is_symlink() or not target.resolve().is_relative_to(APP.resolve()):raise ValueError('Lien serveur refusé : '+name)
  if target.is_file():result[name]=target.read_bytes()
 return result
def atomic_json(path,value):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,indent=2)+'\n');tmp.chmod(0o600);os.replace(tmp,path)
def install_file(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 fd,temp=tempfile.mkstemp(dir=path.parent,prefix='.cicd-')
 try:
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(temp,0o640);os.chown(temp,0,grp.getgrnam('nextech').gr_gid);os.replace(temp,path)
 finally:
  if os.path.exists(temp):os.unlink(temp)
def fetch():
 if not REPO.exists():run(['git','clone','--bare',REMOTE,str(REPO)])
 git('fetch','--prune','origin','+refs/heads/main:refs/heads/main')
 return git('rev-parse','refs/heads/main').decode().strip()
def guard(action,backup):
 return run([RUNUSER,'-u','nextech','--','node',GUARD,action,str(backup)])
def health():
 run(['systemctl','is-active',*SERVICES])
 # TLS validation is enabled; no authentication or business request.
 with urllib.request.urlopen('https://v3.nextechlogistic.fr/',timeout=20) as response:
  if response.status!=200:raise ValueError('HTTP non conforme')
  if response.read()!= (APP/'public/index.html').read_bytes():raise ValueError('Version HTTP différente')
def wait_web():
 for _ in range(45):
  try:
   run(['systemctl','is-active','nextech-web'])
   with urllib.request.urlopen('https://v3.nextechlogistic.fr/',timeout=10) as r:
    if r.status==200 and r.read()==(APP/'public/index.html').read_bytes():return
  except Exception:pass
  time.sleep(2)
 raise ValueError('Le nouveau serveur web ne répond pas correctement')
def stop(service):
 run(['systemctl','stop',service])
 if run(['systemctl','show',service,'-p','Result','--value']).strip()!=b'success':raise ValueError('Arrêt non propre : '+service)
def verify_environment():
 env=Path('/etc/nextech/application.env')
 if not env.is_file() or env.stat().st_uid!=0 or env.stat().st_mode&0o007:raise ValueError('Environnement de production non sécurisé')
 names={x.split('=',1)[0] for x in env.read_text().splitlines() if '=' in x and not x.startswith('#')}
 if not {'DATABASE_URL','PUBLIC_ORIGIN','PORT','SHOP_VAULT_FILE'}<=names:raise ValueError('Variables requises absentes')
 for service in SERVICES:
  if str(env) not in run(['systemctl','show',service,'-p','EnvironmentFiles','--value']).decode():raise ValueError('EnvironmentFile absent : '+service)
 return digest(env.read_bytes())

def deploy(commit,packet=None):
 if not re.fullmatch('[a-f0-9]{40}',commit):raise ValueError('Commit invalide')
 STATE.mkdir(mode=0o700,exist_ok=True)
 report={'commit':commit,'startedAt':time.time(),'status':'running','businessWritesForTesting':0}
 journal=STATE/'reports'/('deploy-'+commit+'.json');journal.parent.mkdir(mode=0o700,exist_ok=True)
 changed=[];original={};paused=False;stopped=False;installed=False;deps_swapped=False;backup=None
 try:
  atomic_json(journal,report)
  head=fetch()
  if commit!=head:
   report['status']='superseded';report['reason']='Un push plus récent existe';return report
  baseline=json.loads((STATE/'baseline.json').read_text())
  git('merge-base','--is-ancestor',baseline['commit'],commit)
  old,new=tree(baseline['commit']),tree(commit)
  names=set(old)|set(new);current=read_current(names)
  changed=plan(old,new,current,baseline['serverHashes']);report['files']=changed
  if packet is None:raise ValueError('Manifeste CI absent')
  proofs={name:base64.b64decode(value,validate=True) for name,value in packet['proofs'].items()}
  validate_manifest(packet['manifest'],proofs,commit,changed)
  proof_dir=STATE/'proofs'/commit;proof_dir.mkdir(parents=True,mode=0o700,exist_ok=True)
  for name,data in proofs.items():
   if name not in ('checks.log','desktop.png','mobile.png','performance.json'):raise ValueError('Nom de preuve refusé')
   target=proof_dir/name;target.write_bytes(data);target.chmod(0o600)
  atomic_json(proof_dir/'manifest.json',packet['manifest'])
  report['verification']={'status':'PASS','commit':commit,'proofs':{name:digest(data) for name,data in proofs.items()},'serverBaseline':'PASS'}
  env_hash=verify_environment()
  report['environmentHashBefore']=env_hash;report['baselineCommitBefore']=baseline['commit']
  # Dependency installation and tests are isolated from production secrets/database.
  with tempfile.TemporaryDirectory(prefix='v3-build-',dir=BUILD_ROOT) as workspace:
   candidate=Path(workspace)/'candidate';candidate.mkdir()
   archive=git('archive',commit)
   import tarfile,io
   with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(candidate,filter='data')
   run(['chown','-R','nextech-build:nextech-build',workspace]);os.chmod(workspace,0o750)
   isolated={'PATH':'/usr/bin:/bin','HOME':'/var/lib/nextech-build','NODE_ENV':'test','CI':'true'}
   for command,timeout in [(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],600),(['npm','run','check'],180),(['npm','test'],900),(['python3','-m','unittest','discover','-s','deploy','-p','test_*.py'],60)]:
    run([RUNUSER,'-u','nextech-build','--',*command],cwd=candidate,env=isolated,timeout=timeout)
   report['checks']='PASS'
   if not changed:
    health();baseline['commit']=commit;atomic_json(STATE/'baseline.json',baseline);report['status']='deployed';report['restart']=False;return report
   backup=Path('/var/backups/nextech')/('cicd-'+commit+'-'+str(int(time.time())));backup.mkdir(mode=0o700)
   original={x['path']:current.get(x['path']) for x in changed}
   for name,data in original.items():
    if data is not None:
     target=backup/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);target.chmod(0o600)
   atomic_json(backup/'manifest.json',report)
   backend=any(x['path'].startswith('src/') or x['path'].startswith('package') for x in changed)
   report['restart']=backend;report['backup']=str(backup)
   if backend:
    worker_pid_before=int(run(['systemctl','show','nextech-worker','-p','MainPID','--value']).strip())
    # Pause only scheduling, wait for natural completion. Never replay a business write.
    paused=True;guard('pause',backup)
    for _ in range(120):
     try:guard('check',backup);break
     except subprocess.CalledProcessError:time.sleep(10)
    else:raise ValueError('Traitements encore actifs : déploiement différé')
    stopped=True;stop('nextech-worker');guard('check',backup);stop('nextech-web');guard('check',backup)
   # Recheck after draining, under the same global lock.
   latest=read_current(names)
   if plan(old,new,latest,baseline['serverHashes'])!=changed:raise ValueError('Conflit avant installation')
   if verify_environment()!=env_hash:raise ValueError('Configuration modifiée pendant publication')
   installed=True
   for item in changed:
    path=APP/item['path']
    if item['after'] is None:path.unlink()
    else:install_file(path,new[item['path']])
   if any(x['path'] in ('package.json','package-lock.json') for x in changed):
    shutil.copytree(candidate/'node_modules',backup/'new-node_modules',symlinks=True)
    os.rename(APP/'node_modules',backup/'old-node_modules');deps_swapped=True
    os.rename(backup/'new-node_modules',APP/'node_modules')
    run(['chown','-R','root:nextech',str(APP/'node_modules')])
   for item in changed:
    path=APP/item['path'];actual=digest(path.read_bytes()) if path.is_file() else None
    if actual!=item['after']:raise ValueError('Empreinte installée incorrecte : '+item['path'])
   if backend:run(['systemctl','start','nextech-web']);wait_web();run(['systemctl','start','nextech-worker'])
   health()
   if verify_environment()!=env_hash:raise ValueError('Environnement de production altéré')
   for item in changed:baseline['serverHashes'][item['path']]=item['after']
   baseline['commit']=commit;atomic_json(STATE/'baseline.json',baseline)
   report['status']='deployed'
 except Exception as error:
  # Never expose subprocess stderr: it may contain a credential from application output.
  report['status']='failed';report['error']=str(error) if not isinstance(error,subprocess.CalledProcessError) else 'Une commande de contrôle a échoué (code '+str(error.returncode)+')'
  if installed:
   try:
    if stopped:
     stop('nextech-worker');stop('nextech-web')
    for name,data in original.items():
     if data is None:(APP/name).unlink(missing_ok=True)
     else:install_file(APP/name,data)
    if deps_swapped:
     if (APP/'node_modules').exists():os.rename(APP/'node_modules',backup/'failed-node_modules')
     os.rename(backup/'old-node_modules',APP/'node_modules')
    report['rollback']='files-restored'
   except Exception:report['rollback']='FAILED';report['manualIntervention']=True
  if stopped:
   try:run(['systemctl','start',*SERVICES]);wait_web();health();report['rollbackHealth']='PASS'
   except Exception:report['rollbackHealth']='FAILED';report['manualIntervention']=True
  elif installed:
   try:health();report['rollbackHealth']='PASS'
   except Exception:report['rollbackHealth']='FAILED';report['manualIntervention']=True
 finally:
  report['installed']=installed;report['paused']=paused
  if paused:
   try:
    if commit in ('29a9e13cb53da42859befd6ea5199cda77a2fc58','571fcd4524b08425031ce8165c32b3f9e750232b','50a0ac22924bf9f2bff394d6d694cf86a3abc966','0337ef46318f3a023855bb112b36cc97b80e2fa3','227f3c682207e9a1bf65475052131dfd3f4c0e37'):
     from preserve_worker_capacity import preserve
     report['workerCapacity']=preserve(worker_pid_before,backup)
    guard('resume',backup);guard('verify-restored',backup);report['taskControlsRestored']=True
   except Exception:report['taskControlsRestored']=False;report['manualIntervention']=True;report['status']='failed'
  report['finishedAt']=time.time();atomic_json(journal,report)
 return report

if __name__=='__main__':
 import fcntl
 if os.geteuid()!=0 or len(sys.argv)!=3 or sys.argv[1]!='deploy':sys.exit('Usage: dispatcher.py deploy COMMIT')
 def interrupted(signum,frame):raise RuntimeError('Publication interrompue par signal '+str(signum))
 for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(sig,interrupted)
 packet_raw=sys.stdin.buffer.read(2*1024*1024+1)
 if len(packet_raw)>2*1024*1024:sys.exit('Preuves CI trop volumineuses')
 packet=json.loads(packet_raw);commit=sys.argv[2]
 if not re.fullmatch('[a-f0-9]{40}',commit):sys.exit('Commit invalide')
 STATE.mkdir(mode=0o700,exist_ok=True);request_dir=STATE/'requests';request_dir.mkdir(mode=0o700,exist_ok=True)
 request_path=request_dir/(commit+'.json')
 existing=json.loads(request_path.read_text()) if request_path.exists() else None
 if existing and existing['status'] in ('failed','resolved'):sys.exit('Ce commit a échoué ; résoudre le blocage et publier un nouveau commit corrigé')
 record=existing or {'id':str(uuid.uuid5(uuid.NAMESPACE_URL,'nextech-cicd:'+commit)),'commit':commit,'section':7,'serverManaged':True,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'ready'}
 deadline=time.monotonic()+1200
 while True:
  deferred=[]
  with open('/var/lock/nextech-deploy.lock','a') as lock:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:
    if time.monotonic()>deadline:sys.exit('Verrou Section7 encore occupé')
    time.sleep(2);continue
   mirror=STATE/'local-queue.json'
   if not mirror.exists():sys.exit('File commune non initialisée ; publication refusée')
   local=json.loads(mirror.read_text())['requests']
   automatic=[json.loads(p.read_text()) for p in request_dir.glob('*.json')]
   head=fetch()
   for old_record in automatic:
    if old_record['commit']!=head and old_record['status'] in ('ready','blocked') and not old_record.get('requiresReplacement') and not old_record.get('report',{}).get('manualIntervention'):
     old_record['status']='superseded';atomic_json(request_dir/(old_record['commit']+'.json'),old_record)
   if commit!=head:
    record['status']='superseded';atomic_json(request_path,record);print(json.dumps(record));sys.exit(0)
   deferred=blockers(local,automatic,record['id'],record['createdAt'])
   priority_path=STATE/'human-priorities'/(commit+'.json')
   authorization=json.loads(priority_path.read_text()) if priority_path.exists() else None
   deferred=apply_human_priority(deferred,commit,authorization)
   if not deferred:
    record['status']='deploying';atomic_json(request_path,record)
    result=deploy(commit,packet);record['status']=result['status'];record['requiresReplacement']=result['status']=='failed';record['updatedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['report']=result;atomic_json(request_path,record)
    print(json.dumps(result));sys.exit(0 if result['status'] in ('deployed','superseded') else 1)
   record['status']='ready';record['waitingFor']=[r['id'] for r in deferred];atomic_json(request_path,record)
  # Release the global lock so Section7 can publish the older request.
  if time.monotonic()>deadline:
   record['status']='blocked';atomic_json(request_path,record);print(json.dumps({'status':'blocked','request':record,'reason':'Demande antérieure encore ouverte'}));sys.exit(1)
  time.sleep(10)
