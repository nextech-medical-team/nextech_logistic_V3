import unittest,tempfile,json,io,tarfile
from pathlib import Path
from unittest.mock import patch
import dispatcher as d

class DispatcherTests(unittest.TestCase):
 def test_runuser_uses_absolute_path_with_restricted_environment(self):
  with patch.object(d.subprocess,'run') as invoke:
   invoke.return_value.stdout=b''
   d.guard('check',Path('/tmp/backup'))
   self.assertEqual(invoke.call_args.args[0][0],'/usr/sbin/runuser')
  self.assertEqual(d.RUNUSER,'/usr/sbin/runuser')
 def test_health_checks_served_version(self):
  with tempfile.TemporaryDirectory() as td:
   app=Path(td);(app/'public').mkdir();(app/'public/index.html').write_bytes(b'new')
   class Response:
    status=200
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self):return b'old'
   with patch.object(d,'APP',app),patch.object(d,'run',return_value=b''),patch.object(d.urllib.request,'urlopen',return_value=Response()):
    with self.assertRaisesRegex(ValueError,'Version HTTP'):d.health()
 def test_server_symlink_rejected(self):
  # symlink creation requires privileges on some Windows hosts; always run on CI Linux.
  import os
  if os.name=='nt':self.skipTest('Contrôle symlink exécuté sur le runner Linux')
  with tempfile.TemporaryDirectory() as td:
   app=Path(td)/'app';app.mkdir();(app/'src').mkdir();secret=Path(td)/'secret';secret.write_bytes(b'secret')
   (app/'src/x.mjs').symlink_to(secret)
   with patch.object(d,'APP',app):
    with self.assertRaisesRegex(ValueError,'Lien'):d.read_current(['src/x.mjs'])
 def test_install_is_atomic(self):
  with tempfile.TemporaryDirectory() as td:
   target=Path(td)/'app.js';target.write_bytes(b'old')
   with patch.object(d.os,'chown',create=True),patch.object(d.grp,'getgrnam') as group:
    group.return_value.gr_gid=100;d.install_file(target,b'new')
   self.assertEqual(target.read_bytes(),b'new');self.assertEqual(list(Path(td).glob('.cicd-*')),[])
 def test_restore_selected_files_after_failed_health(self):
  # Exercise the real orchestration/rollback on disposable files, without systemctl/DB/Git/network.
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);app=root/'app';(app/'public').mkdir(parents=True);(app/'public/x.js').write_bytes(b'old');(app/'public/other.js').write_bytes(b'colleague')
   state=root/'state';state.mkdir();(state/'baseline.json').write_text(json.dumps({'commit':'a'*40,'serverHashes':{'public/x.js':d.digest(b'old')}}))
   archive=io.BytesIO()
   with tarfile.open(fileobj=archive,mode='w'):pass
   real_json=d.atomic_json
   def fake_install(path,data):path.write_bytes(data)
   backup_root=root/'backups';backup_root.mkdir()
   # Patch Path for only the fixed backup root; every other path retains real filesystem behavior.
   real_path=d.Path
   def path_override(value):return backup_root if str(value)=='/var/backups/nextech' else real_path(value)
   with patch.object(d,'validate_manifest',return_value=True),patch.object(d,'BUILD_ROOT',td),patch.object(d,'STATE',state),patch.object(d,'APP',app),patch.object(d,'Path',side_effect=path_override),patch.object(d,'fetch',return_value='b'*40),patch.object(d,'git',side_effect=lambda *args:archive.getvalue() if args[0]=='archive' else b''),patch.object(d,'tree',side_effect=[{'public/x.js':b'old'},{'public/x.js':b'new'}]),patch.object(d,'verify_environment',return_value='hash'),patch.object(d,'run',return_value=b''),patch.object(d,'install_file',side_effect=fake_install),patch.object(d,'health',side_effect=[ValueError('bad health'),None]):
    result=d.deploy('b'*40,{'manifest':{},'proofs':{}})
   self.assertEqual(result['status'],'failed');self.assertEqual(result['rollback'],'files-restored')
   self.assertEqual(result['rollbackHealth'],'PASS')
   self.assertEqual((app/'public/x.js').read_bytes(),b'old');self.assertEqual((app/'public/other.js').read_bytes(),b'colleague')
   self.assertEqual(json.loads((state/'baseline.json').read_text())['commit'],'a'*40)
 def test_isolated_test_timeout_fails_before_backup_or_install(self):
  # Exercise the real pre-install gate; a larger finite budget must not bypass failures.
  with tempfile.TemporaryDirectory() as td:
   root=Path(td);app=root/'app';(app/'public').mkdir(parents=True);target=app/'public/x.js';target.write_bytes(b'old')
   state=root/'state';state.mkdir();baseline={'commit':'a'*40,'serverHashes':{'public/x.js':d.digest(b'old')}};(state/'baseline.json').write_text(json.dumps(baseline))
   archive=io.BytesIO()
   with tarfile.open(fileobj=archive,mode='w'):pass
   seen=[]
   def isolated_run(args,**kwargs):
    if args[-2:]==['npm','test']:
     seen.append(kwargs)
     raise d.subprocess.TimeoutExpired(args,kwargs['timeout'])
    return b''
   with patch.object(d,'validate_manifest',return_value=True),patch.object(d,'BUILD_ROOT',td),patch.object(d,'STATE',state),patch.object(d,'APP',app),patch.object(d,'fetch',return_value='b'*40),patch.object(d,'git',side_effect=lambda *args:archive.getvalue() if args[0]=='archive' else b''),patch.object(d,'tree',side_effect=[{'public/x.js':b'old'},{'public/x.js':b'new'}]),patch.object(d,'verify_environment',return_value='hash'),patch.object(d,'run',side_effect=isolated_run),patch.object(d,'install_file') as install,patch.object(d,'guard') as guard:
    result=d.deploy('b'*40,{'manifest':{},'proofs':{}})
   self.assertEqual(len(seen),1);self.assertEqual(seen[0]['timeout'],1800)
   self.assertEqual(seen[0]['env'],{'PATH':'/usr/bin:/bin','HOME':'/var/lib/nextech-build','NODE_ENV':'test','CI':'true'})
   self.assertEqual(result['status'],'failed');self.assertFalse(result['installed']);self.assertFalse(result['paused']);self.assertNotIn('backup',result)
   install.assert_not_called();guard.assert_not_called()
   self.assertEqual(target.read_bytes(),b'old');self.assertEqual(json.loads((state/'baseline.json').read_text()),baseline)
if __name__=='__main__':unittest.main()
