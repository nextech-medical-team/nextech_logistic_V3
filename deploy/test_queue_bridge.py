import tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
import queue_bridge as bridge
import dispatcher
class BridgeTests(unittest.TestCase):
 def test_restoration_requires_files_environment_health_and_controls(self):
  from contextlib import ExitStack
  data=b'previous';sha=dispatcher.digest(data)
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'baseline.json').write_text(json.dumps({'commit':'a'*40,'serverHashes':{'public/app.js':sha},'environmentHash':'env'}))
   record={'report':{'baselineCommitBefore':'a'*40,'environmentHashBefore':'env','files':[{'path':'public/app.js','before':sha}],'paused':True,'backup':'/var/backups/nextech/example'}}
   with ExitStack() as stack:
    stack.enter_context(patch.object(bridge,'STATE',state))
    current=stack.enter_context(patch.object(dispatcher,'read_current',return_value={'public/app.js':data}))
    env=stack.enter_context(patch.object(dispatcher,'verify_environment',return_value='env'))
    health=stack.enter_context(patch.object(dispatcher,'health'))
    guard=stack.enter_context(patch.object(dispatcher,'guard'))
    self.assertTrue(bridge.restoration_certificate(record)['verified']);guard.assert_called_once()
    for mocked,bad in ((current,{'public/app.js':b'wrong'}),(env,'wrong')):
     previous=mocked.return_value;mocked.return_value=bad
     with self.assertRaises(ValueError):bridge.restoration_certificate(record)
     mocked.return_value=previous
    for mocked in (health,guard):
     mocked.side_effect=ValueError('unresolved')
     with self.assertRaises(ValueError):bridge.restoration_certificate(record)
     mocked.side_effect=None
 def test_resolution_cannot_clear_failure_without_server_certificate(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'requests').mkdir();(state/'reports').mkdir()
   identifier='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
   record={'id':identifier,'commit':'a'*40,'status':'failed','requiresReplacement':True,'report':{'rollback':'FAILED','manualIntervention':True}}
   target=state/'requests'/'failure.json';target.write_text(json.dumps(record))
   payload={'version':1,'revision':1,'requests':[],'resolveAutomatic':[identifier]}
   with patch.object(bridge,'STATE',state),patch.object(bridge,'restoration_certificate',side_effect=ValueError('not restored')):
    with self.assertRaises(ValueError):bridge.sync(payload)
   self.assertEqual(json.loads(target.read_text())['status'],'failed');self.assertFalse((state/'local-queue.json').exists())
   with patch.object(bridge,'STATE',state),patch.object(bridge,'restoration_certificate',return_value={'verified':True}):
    result=bridge.sync(payload)['automaticRequests'][0]
   self.assertEqual(result['status'],'resolved');self.assertFalse(result['requiresReplacement']);self.assertTrue(result['resolution']['verified'])
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
