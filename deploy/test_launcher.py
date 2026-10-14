import unittest,subprocess
from pathlib import Path
from unittest.mock import patch
import preserve_worker_capacity as capacity

class LauncherTests(unittest.TestCase):
 def test_kernel_launch_and_lf(self):
  p=Path(__file__).parent/'dispatcher.py'
  self.assertNotIn(b'\r\n',p.read_bytes())
  result=subprocess.run([str(p)],capture_output=True,text=True,timeout=10)
  self.assertEqual(result.returncode,1)
  self.assertIn('Usage: dispatcher.py deploy COMMIT',result.stderr)
 def test_same_worker_does_not_open_inspector(self):
  with patch.object(capacity,'run',return_value=b'123'),patch.object(capacity.os,'kill') as kill:
   self.assertEqual(capacity.preserve(123,Path('/unused'))['status'],'unchanged-process')
   kill.assert_not_called()
 def test_missing_worker_blocks_resume(self):
  with patch.object(capacity,'run',return_value=b'0'):
   with self.assertRaises(RuntimeError):capacity.preserve(123,Path('/unused'))
 def test_existing_inspector_is_not_touched(self):
  with patch.object(capacity,'run',side_effect=[b'456',b'']),patch.object(capacity,'port_open',return_value=True),patch.object(capacity.os,'kill') as kill:
   with self.assertRaises(RuntimeError):capacity.preserve(123,Path('/unused'))
   kill.assert_not_called()
