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

 def test_pending_recipe_certificate_is_server_owned_and_immutable(self):
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'requests').mkdir();(state/'reports').mkdir()
   row={'id':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','status':'recipe_pending','createdAt':'2026-10-12T10:00:00Z','publication':{'commit':'a'*40},'publicationCertificate':{'verified':True}}
   def payload(revision):return {'version':1,'revision':revision,'requests':[dict(row)]}
   with patch.object(bridge,'STATE',state),patch.object(bridge,'publication_certificate',side_effect=ValueError('unverified')) as certify:
    with self.assertRaises(ValueError):bridge.sync(payload(1))
    self.assertFalse((state/'local-queue.json').exists())
   with patch.object(bridge,'STATE',state),patch.object(bridge,'publication_certificate',return_value=True) as certify:
    bridge.sync(payload(1));certify.assert_called_once()
   with patch.object(bridge,'STATE',state),patch.object(bridge,'publication_certificate',side_effect=ValueError('unverified')) as certify:
    bridge.sync(payload(2));certify.assert_not_called()
    row['publication']={'commit':'b'*40}
    with self.assertRaises(ValueError):bridge.sync(payload(3))
    self.assertEqual(json.loads((state/'local-queue.json').read_text())['revision'],2)

 def test_publication_certificate_checks_runtime_and_restore(self):
  from contextlib import ExitStack
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);data=b'installed';sha=dispatcher.digest(data)
   (state/'baseline.json').write_text(json.dumps({'commit':'a'*40}))
   row={'publication':{'status':'verified','commit':'a'*40,'environmentHash':'b'*64,'controlsRestored':True,'backup':'/var/backups/nextech/test','files':{'src/a.mjs':sha}}}
   with ExitStack() as st:
    st.enter_context(patch.object(bridge,'STATE',state))
    current=st.enter_context(patch.object(dispatcher,'read_current',return_value={'src/a.mjs':data}))
    env=st.enter_context(patch.object(dispatcher,'verify_environment',return_value='b'*64))
    health=st.enter_context(patch.object(dispatcher,'health'))
    guard=st.enter_context(patch.object(dispatcher,'guard'))
    self.assertTrue(bridge.publication_certificate(row));guard.assert_called_once()
    for mocked,bad in [(current,{'src/a.mjs':b'other'}),(env,'c'*64)]:
     good=mocked.return_value;mocked.return_value=bad
     with self.assertRaises(ValueError):bridge.publication_certificate(row)
     mocked.return_value=good
    for mocked in [health,guard]:
     mocked.side_effect=ValueError('not verified')
     with self.assertRaises(ValueError):bridge.publication_certificate(row)
     mocked.side_effect=None

 def test_publication_certificate_rejects_unsafe_backup(self):
  for backup in ['/var/backups/nextech','/tmp/other','/var/backups/nextech/../other','relative']:
   row={'publication':{'status':'verified','commit':'a'*40,'environmentHash':'b'*64,'controlsRestored':True,'backup':backup,'files':{'src/a.mjs':'c'*64}}}
   with self.subTest(backup=backup),self.assertRaisesRegex(ValueError,'Sauvegarde'):
    bridge.publication_certificate(row)
