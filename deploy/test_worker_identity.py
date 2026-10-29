import unittest,json,tempfile
from pathlib import Path
from unittest.mock import patch
import preserve_worker_capacity as capacity

class IdentityTests(unittest.TestCase):
 def setUp(self):
  signal_patch=patch.object(capacity.signal,'SIGUSR1',10,create=True);signal_patch.start();self.addCleanup(signal_patch.stop)
 def test_stat_comm_with_spaces_and_parentheses(self):
  boot='12345678-1234-1234-1234-123456789abc'
  stat='123 (node (worker)) '+' '.join(['S']+['0']*18+['98765']+['0']*5)
  with patch.object(Path,'read_text',side_effect=[boot,stat]):
   self.assertEqual(capacity.worker_identity(123),{'pid':123,'bootId':boot,'startTicks':'98765'})
 def test_missing_malformed_and_wrong_pid_fail_closed(self):
  for stat in ['','124 (node) S 0','123 (node) S invalid']:
   with patch.object(Path,'read_text',side_effect=['12345678-1234-1234-1234-123456789abc',stat]):
    with self.assertRaises(RuntimeError):capacity.worker_identity(123)
 def test_proc_disappearance_propagates(self):
  with patch.object(Path,'read_text',side_effect=FileNotFoundError):
   with self.assertRaises(FileNotFoundError):capacity.worker_identity(123)
 def test_preservation_binds_saved_receipt_to_process_identity(self):
  identity={'pid':456,'bootId':'12345678-1234-1234-1234-123456789abc','startTicks':'98765'}
  receipt={'after':{'max':20},'businessRequestsIssued':0}
  with tempfile.TemporaryDirectory() as folder,patch.object(capacity,'run',side_effect=[b'456',b'',b'456',json.dumps(receipt).encode()]),patch.object(capacity,'port_open',return_value=False),patch.object(capacity,'worker_identity',return_value=identity),patch.object(capacity.os,'kill'),patch.object(capacity.time,'sleep'):
   result=capacity.preserve(123,Path(folder))
   self.assertEqual(result['receipt']['workerIdentity'],identity)
   self.assertEqual(json.loads((Path(folder)/'pool-preserved.json').read_text()),result['receipt'])
 def test_worker_change_after_capacity_read_cannot_produce_receipt(self):
  identity={'pid':456,'bootId':'12345678-1234-1234-1234-123456789abc','startTicks':'98765'}
  with tempfile.TemporaryDirectory() as folder,patch.object(capacity,'run',side_effect=[b'456',b'',b'456',b'{"after":{"max":20}}']),patch.object(capacity,'port_open',return_value=False),patch.object(capacity,'worker_identity',side_effect=[identity,{**identity,'startTicks':'98766'}]),patch.object(capacity.os,'kill'),patch.object(capacity.time,'sleep'):
   with self.assertRaises(RuntimeError):capacity.preserve(123,Path(folder))
   self.assertFalse((Path(folder)/'pool-preserved.json').exists())
if __name__=='__main__':unittest.main()
