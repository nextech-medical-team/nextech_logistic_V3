#!/usr/bin/python3
"""One-time infrastructure installation, exclusively by Section 7 under deployment lock.
No application file, business setting or service is changed by this installer.
"""
import argparse,os,json,hashlib,subprocess,pathlib,shutil,grp
P=pathlib.Path
def hash_file(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def install(bundle,baseline_file,public_key_file):
 if os.geteuid()!=0:raise ValueError('Installation Section 7 root nécessaire')
 baseline=json.loads(baseline_file.read_text());key=public_key_file.read_text().strip()
 if not key.startswith('ssh-ed25519 ') or '\n' in key:raise ValueError('Clé publique invalide')
 # Confirm the complete initial server inventory immediately before the baseline is recorded.
 app=P('/opt/nextech/current')
 for name,expected in baseline['serverHashes'].items():
  target=app/name
  if not target.is_file() or hash_file(target)!=expected:raise ValueError('Sources modifiées avant initialisation : '+name)
 state=P('/var/lib/nextech-cicd');lib=P('/usr/local/lib/nextech-cicd')
 if (state/'baseline.json').exists():raise ValueError('CI/CD déjà initialisé ; ne pas réinitialiser la référence')
 # Verify reviewed infrastructure bytes before installing executable code.
 approved=json.loads((bundle/'approved-files.json').read_text())
 for name,sha in approved.items():
  if '/' in name or name not in ('dispatcher.py','plan.py','runtime-guard.mjs','ssh-entry.sh'):raise ValueError('Artefact refusé')
  if hash_file(bundle/name)!=sha:raise ValueError('Artefact modifié : '+name)
 if set(approved)!= {'dispatcher.py','plan.py','runtime-guard.mjs','ssh-entry.sh'}:raise ValueError('Artefacts incomplets')
 subprocess.run(['python3','-m','py_compile',str(bundle/'dispatcher.py'),str(bundle/'plan.py')],check=True)
 subprocess.run(['node','--check',str(bundle/'runtime-guard.mjs')],check=True)
 subprocess.run(['bash','-n',str(bundle/'ssh-entry.sh')],check=True)
 subprocess.run(['getent','passwd','nextech-build'],stdout=subprocess.DEVNULL,check=False).returncode==0 or subprocess.run(['useradd','--system','--create-home','--home-dir','/var/lib/nextech-build','--shell','/usr/sbin/nologin','nextech-build'],check=True)
 state.mkdir(mode=0o700,exist_ok=True);state.chmod(0o700);lib.mkdir(mode=0o755,parents=True,exist_ok=True)
 for name in approved:
  dest=lib/name;shutil.copyfile(bundle/name,dest);os.chown(dest,0,0);dest.chmod(0o755 if name in ('dispatcher.py','ssh-entry.sh') else 0o644)
 env=P('/etc/nextech/application.env')
 if env.stat().st_uid!=0 or env.stat().st_mode&0o007:raise ValueError('Permissions environnement dangereuses')
 # Existing systemd EnvironmentFile and private values are preserved verbatim.
 before_env=hash_file(env)
 sudoers=P('/etc/sudoers.d/nextech-cicd')
 sudoers.write_text('ubuntu ALL=(root) NOPASSWD: /usr/local/lib/nextech-cicd/dispatcher.py deploy *\n');sudoers.chmod(0o440);os.chown(sudoers,0,0)
 subprocess.run(['visudo','-cf',str(sudoers)],check=True,stdout=subprocess.DEVNULL)
 ssh=P('/home/ubuntu/.ssh');ssh.mkdir(mode=0o700,exist_ok=True)
 authorized=ssh/'authorized_keys';old=authorized.read_text() if authorized.exists() else ''
 line='restrict,command="/usr/local/lib/nextech-cicd/ssh-entry.sh" '+key
 if key.split()[1] not in old:authorized.write_text(old.rstrip()+'\n'+line+'\n')
 authorized.chmod(0o600);shutil.chown(ssh,user='ubuntu',group='ubuntu');shutil.chown(authorized,user='ubuntu',group='ubuntu')
 baseline['environmentHash']=before_env;(state/'baseline.json').write_text(json.dumps(baseline,indent=2)+'\n');(state/'baseline.json').chmod(0o600)
 if hash_file(env)!=before_env:raise ValueError('Environnement altéré')
 subprocess.run(['python3','-m','py_compile',str(lib/'dispatcher.py'),str(lib/'plan.py')],check=True)
 subprocess.run(['node','--check',str(lib/'runtime-guard.mjs')],check=True)
 subprocess.run(['bash','-n',str(lib/'ssh-entry.sh')],check=True)
 subprocess.run(['systemctl','is-active','nextech-web','nextech-worker'],check=True)
 print(json.dumps({'status':'installed','baseline':baseline['commit'],'applicationFilesChanged':0,'serviceRestarts':0,'environmentPreserved':True}))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--bundle',type=P,required=True);parser.add_argument('--baseline',type=P,required=True);parser.add_argument('--public-key',type=P,required=True);args=parser.parse_args();install(args.bundle,args.baseline,args.public_key)
