"""Retain the explicitly authorized temporary capacity before resuming scheduling."""
from pathlib import Path
import subprocess,time,socket,os,signal,json,re

def worker_identity(pid):
 if type(pid) is not int or pid<=1:raise RuntimeError('Invalid worker PID')
 boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
 stat=Path('/proc')/str(pid)/'stat'
 raw=stat.read_text();fields=raw[raw.rfind(')')+2:].split()
 # /proc stat field 22, after pid and parenthesized comm (which may contain spaces).
 if not re.fullmatch('[a-f0-9-]{36}',boot) or not raw.startswith(str(pid)+' (') or len(fields)<20 or not fields[19].isdigit():raise RuntimeError('Worker identity unavailable')
 return {'pid':pid,'bootId':boot,'startTicks':fields[19]}

def run(args,**kwargs):
 return subprocess.run(args,check=True,capture_output=True,**kwargs).stdout

def port_open():
 with socket.socket() as sock:return sock.connect_ex(('127.0.0.1',9229))==0

def preserve(previous_pid,backup):
 pid=int(run(['systemctl','show','nextech-worker','-p','MainPID','--value']).strip())
 if pid<=1:raise RuntimeError('Worker absent; scheduling remains paused')
 if pid==previous_pid:return {'status':'unchanged-process','pid':pid}
 # A fresh worker heartbeat and initialized pool are required before the capacity restoration.
 sql="import pg from '/opt/nextech/current/node_modules/pg/lib/index.js';const c=new pg.Client({host:'/var/run/postgresql',user:'nextech',database:'nextech_v3_migration',options:'-c default_transaction_read_only=on'});await c.connect();const r=await c.query(\"SELECT 1 FROM worker_health WHERE role='worker' AND heartbeat>now()-interval '10 seconds'\");await c.end();if(r.rowCount!==1)process.exit(1);"
 for _ in range(60):
  try:run(['/usr/sbin/runuser','-u','nextech','--','node','--input-type=module','-e',sql],timeout=10);break
  except subprocess.CalledProcessError:time.sleep(1)
 else:raise RuntimeError('Worker initialization not verified')
 if port_open():raise RuntimeError('Inspector already open')
 if int(run(['systemctl','show','nextech-worker','-p','MainPID','--value']).strip())!=pid:raise RuntimeError('Worker changed')
 identity=worker_identity(pid)
 helper=Path(__file__).parent
 os.kill(pid,signal.SIGUSR1)
 try:
  receipt=json.loads(run(['node',str(helper/'preserve-pool.mjs'),str(pid)],timeout=25))
  if receipt['after']['max']!=20:raise RuntimeError('Capacity not retained')
  if worker_identity(pid)!=identity:raise RuntimeError('Worker identity changed')
  receipt['workerIdentity']=identity
  (Path(backup)/'pool-preserved.json').write_text(json.dumps(receipt))
 finally:
  time.sleep(3)
  if port_open():
   run(['node',str(helper/'close-inspector.mjs'),str(pid)],timeout=15);time.sleep(3)
  if port_open():raise RuntimeError('Inspector did not close; scheduling remains paused')
 if worker_identity(pid)!=identity:raise RuntimeError('Worker identity changed')
 return {'status':'preserved','pid':pid,'receipt':receipt,'inspectorClosed':True}
