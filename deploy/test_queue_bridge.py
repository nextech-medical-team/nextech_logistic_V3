import tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
import queue_bridge as bridge
class BridgeTests(unittest.TestCase):
 def test_snapshot_fifo_and_reports_are_connected(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'requests').mkdir();(state/'reports').mkdir()
   row={'id':'a'*8+'-'+('b'*4)+'-'+('c'*4)+'-'+('d'*4)+'-'+('e'*12),'status':'blocked','createdAt':'2026-10-10T10:00:00Z'}
   record={'id':'f'*8+'-'+('a'*4)+'-'+('b'*4)+'-'+('c'*4)+'-'+('d'*12),'commit':'a'*40,'status':'deploying','createdAt':'2026-10-10T10:01:00Z'}
   (state/'requests'/'ci.json').write_text(json.dumps(record));(state/'reports'/('deploy-'+record['commit']+'.json')).write_text(json.dumps({'status':'deployed','verification':{'status':'PASS'}}))
   with patch.object(bridge,'STATE',state):
    reply=bridge.sync({'version':1,'revision':2,'requests':[row]})
    self.assertEqual(reply['automaticRequests'][0]['status'],'deployed');self.assertEqual(json.loads((state/'local-queue.json').read_text())['requests'],[row])
    with self.assertRaisesRegex(ValueError,'ancien'):bridge.sync({'version':1,'revision':1,'requests':[]})
 def test_invalid_snapshot_does_not_replace_file(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'local-queue.json').write_text('{"revision":5,"requests":[]}')
   with patch.object(bridge,'STATE',state):
    with self.assertRaises(ValueError):bridge.sync({'version':1,'revision':6,'requests':[{'id':'../unsafe','status':'ready','createdAt':'now'}]})
   self.assertEqual(json.loads((state/'local-queue.json').read_text())['revision'],5)
