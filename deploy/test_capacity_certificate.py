import copy,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import queue_bridge as bridge
import preserve_worker_capacity as capacity

class CapacityCertificateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.backup=Path(self.tmp.name)
  self.identity={'pid':123,'bootId':'a'*36,'startTicks':'456'}
  self.identity_mock=patch.object(capacity,'worker_identity',return_value=self.identity).start();self.addCleanup(patch.stopall)
  self.receipt={'at':'2026-10-29T12:00:00Z','after':{'max':20},'businessRequestsIssued':0,'workerIdentity':self.identity}
  self.report={'workerCapacity':{'status':'preserved','pid':123,'receipt':self.receipt,'inspectorClosed':True}}
  (self.backup/'pool-preserved.json').write_text(json.dumps(self.receipt))
 def check(self,pids=None,opened=False):
  with patch.object(capacity,'run',side_effect=pids or [b'123',b'123']) as run,patch.object(capacity,'port_open',return_value=opened),patch.object(capacity.os,'kill',side_effect=AssertionError('must never signal worker')):
   result=bridge.worker_capacity_certificate(self.report,self.backup)
   self.assertEqual(run.call_count,2);return result
 def test_exact_receipt_current_pid_closed_inspector(self):
  before=copy.deepcopy(self.report);self.assertEqual(self.check()['capacity'],20);self.assertEqual(before,self.report)
 def test_missing_failed_and_unchanged_process_are_not_capacity_proof(self):
  for value in [{},{'status':'unchanged-process','pid':123},{'status':'failed'}]:
   self.report={'workerCapacity':value}
   with self.assertRaises(ValueError):self.check()
 def test_old_pid_restart_during_check_and_open_inspector(self):
  for pids,opened in [([b'456'],False),([b'123',b'456'],False),([b'123'],True)]:
   with self.assertRaises(ValueError):self.check(pids,opened)
 def test_wrong_capacity_or_business_activity_refused(self):
  for receipt in [{'after':{'max':10},'businessRequestsIssued':0},{'after':{'max':20},'businessRequestsIssued':1}]:
   self.report['workerCapacity']['receipt']=receipt
   with self.assertRaises(ValueError):self.check()
 def test_missing_or_different_backup_receipt_refused(self):
  file=self.backup/'pool-preserved.json';file.write_text('{}')
  with self.assertRaises(ValueError):self.check()
  file.unlink()
  with self.assertRaises(ValueError):self.check()
 def test_reused_pid_different_boot_or_start_time_refused(self):
  for key,value in [('bootId','b'*36),('startTicks','789')]:
   self.identity_mock.return_value={**self.identity,key:value}
   with self.assertRaises(ValueError):self.check()
 def test_identity_changes_during_certificate_refused(self):
  self.identity_mock.side_effect=[self.identity,{**self.identity,'startTicks':'789'}]
  with self.assertRaises(ValueError):self.check()
 def test_legacy_receipt_without_identity_refused(self):
  del self.receipt['workerIdentity']
  with self.assertRaises(ValueError):self.check()
if __name__=='__main__':unittest.main()
