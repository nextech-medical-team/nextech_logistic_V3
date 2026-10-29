import copy,json,tempfile,unittest,subprocess
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
import dispatcher
import queue_bridge as bridge

class InstalledReleaseTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.state=Path(self.tmp.name);self.commit='a'*40;self.data=b'installed'
  self.baseline={'commit':self.commit,'serverHashes':{'src/app.mjs':dispatcher.digest(self.data),'public/removed.js':None},'environmentHash':'env'}
  self.report={'commit':self.commit,'status':'failed','installed':True,'paused':True,'taskControlsRestored':False,'manualIntervention':True,'checks':'PASS','verification':{'status':'PASS','commit':self.commit},'environmentHashBefore':'env','backup':'/var/backups/nextech/cicd-'+self.commit+'-123','files':[{'path':'src/app.mjs','before':'old','after':dispatcher.digest(self.data)}]}
  self.record={'id':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','commit':self.commit,'status':'failed','requiresReplacement':True,'report':self.report}
  self.stack=ExitStack();self.addCleanup(self.stack.close)
  self.stack.enter_context(patch.object(bridge,'STATE',self.state))
  self.current=self.stack.enter_context(patch.object(dispatcher,'read_current',return_value={'src/app.mjs':self.data}))
  self.env=self.stack.enter_context(patch.object(dispatcher,'verify_environment',return_value='env'))
  self.health=self.stack.enter_context(patch.object(dispatcher,'health'))
  self.guard=self.stack.enter_context(patch.object(dispatcher,'guard'))
  self.capacity=self.stack.enter_context(patch.object(bridge,'worker_capacity_certificate',return_value={'pid':123,'capacity':20,'inspectorClosed':True}))
  self.save()
 def save(self):
  (self.state/'baseline.json').write_text(json.dumps(self.baseline))
 def test_installed_release_is_certified_without_rewriting_report_or_baseline(self):
  before=copy.deepcopy(self.record);raw=(self.state/'baseline.json').read_bytes()
  result=bridge.restoration_certificate(self.record)
  self.assertTrue(result['verified']);self.assertEqual(result['type'],'verified-installed-release')
  self.assertEqual(result['installedCommit'],self.commit)
  self.guard.assert_called_once_with('verify-restored',Path(self.report['backup']))
  self.assertEqual(self.record,before);self.assertEqual((self.state/'baseline.json').read_bytes(),raw)
 def test_wrong_commit_or_missing_release_checks_cannot_be_certified(self):
  for change in [lambda:setattr(self,'baseline',{**self.baseline,'commit':'b'*40}),lambda:self.report.update(commit='b'*40),lambda:self.report.update(checks='FAIL'),lambda:self.report.update(verification={'status':'PASS','commit':'b'*40}),lambda:self.report.update(paused=False),lambda:self.report.update(taskControlsRestored=True)]:
   baseline=copy.deepcopy(self.baseline);report=copy.deepcopy(self.report)
   change();self.save()
   with self.assertRaises(ValueError):bridge.installed_release_certificate(self.record)
   self.baseline=baseline;self.report.clear();self.report.update(report);self.save()
 def test_independent_failure_or_rollback_is_not_a_finalization_recovery(self):
  for key,value in [('error','health failed'),('rollback','files-restored'),('rollback','FAILED'),('rollbackHealth','PASS')]:
   self.report[key]=value
   with self.assertRaises(ValueError):bridge.restoration_certificate(self.record)
   del self.report[key]
 def test_file_drift_and_recreated_deleted_files_are_rejected(self):
  for current in [{'src/app.mjs':b'changed'},{'src/app.mjs':self.data,'public/removed.js':b'reappeared'},{}]:
   self.current.return_value=current
   with self.assertRaises(ValueError):bridge.restoration_certificate(self.record)
 def test_manifest_inventory_and_backup_are_required(self):
  for key,value in [('files',[]),('files',[{'path':'src/app.mjs','after':'wrong'}]),('files',[{'path':'private/new','after':None}]),('backup','/tmp/cicd-'+self.commit+'-123'),('backup','/var/backups/nextech/cicd-'+('b'*40)+'-123')]:
   old=self.report[key];self.report[key]=value
   with self.assertRaises(ValueError):bridge.restoration_certificate(self.record)
   self.report[key]=old
 def test_environment_health_and_restored_controls_fail_closed(self):
  self.env.return_value='different'
  with self.assertRaises(ValueError):bridge.restoration_certificate(self.record)
  self.env.return_value='env'
  for mock in [self.health,self.guard,self.capacity]:
   mock.side_effect=subprocess.CalledProcessError(43,['guard'])
   with self.assertRaises(subprocess.CalledProcessError):bridge.restoration_certificate(self.record)
   mock.side_effect=None
 def test_only_explicit_resolution_removes_the_failed_queue_blocker(self):
  (self.state/'requests').mkdir();(self.state/'reports').mkdir()
  file=self.state/'requests'/(self.commit+'.json');file.write_text(json.dumps(self.record))
  (self.state/'reports'/('deploy-'+self.commit+'.json')).write_text(json.dumps(self.report))
  payload={'version':1,'revision':1,'requests':[],'resolvePreinstallFailures':True}
  bridge.sync(payload);self.assertEqual(json.loads(file.read_text())['status'],'failed')
  payload.update(revision=2,resolveAutomatic=[self.record['id']]);bridge.sync(payload)
  resolved=json.loads(file.read_text());self.assertEqual(resolved['status'],'resolved')
  self.assertFalse(resolved['requiresReplacement']);self.assertTrue(resolved['resolution']['verified'])
  self.assertEqual(resolved['report'],self.report)

if __name__=='__main__':unittest.main()
