import io,json,tarfile,tempfile,unittest
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch
import dispatcher as d
import preserve_worker_capacity as capacity

class CapacityReleaseTests(unittest.TestCase):
 def exercise(self,fail=False,static=False):
  with tempfile.TemporaryDirectory() as td,ExitStack() as stack:
   root=Path(td);app=root/'app';name='public/x.js' if static else 'src/x.mjs'
   (app/name).parent.mkdir(parents=True);(app/name).write_bytes(b'old')
   state=root/'state';state.mkdir();(state/'baseline.json').write_text(json.dumps({'commit':'a'*40,'serverHashes':{name:d.digest(b'old')}}))
   backups=root/'backups';backups.mkdir();archive=io.BytesIO()
   with tarfile.open(fileobj=archive,mode='w'):pass
   events=[];real_path=d.Path
   def run(args,**kw):return b'101' if 'MainPID' in args else b''
   def guard(action,backup):events.append(action)
   def preserve(pid,backup):
    events.append('preserve');self.assertEqual(pid,101)
    if fail:raise RuntimeError('capacity unavailable')
    return {'status':'preserved','receipt':{'after':{'max':20}}}
   patches={'STATE':state,'APP':app,'BUILD_ROOT':td,'Path':lambda value:backups if str(value)=='/var/backups/nextech' else real_path(value),'validate_manifest':lambda *a:True,'fetch':lambda:'f'*40,'git':lambda *a:archive.getvalue(),'verify_environment':lambda:'hash','run':run,'guard':guard,'stop':lambda *a:None,'wait_web':lambda:None,'health':lambda:None,'install_file':lambda p,data:p.write_bytes(data)}
   for key,value in patches.items():stack.enter_context(patch.object(d,key,value))
   stack.enter_context(patch.object(d,'tree',side_effect=[{name:b'old'},{name:b'new'}]))
   stack.enter_context(patch.object(capacity,'preserve',side_effect=preserve))
   result=d.deploy('f'*40,{'manifest':{},'proofs':{}})
   return result,events
 def test_new_commit_restores_capacity_before_resuming(self):
  result,events=self.exercise()
  self.assertEqual(result['status'],'deployed');self.assertTrue(result['taskControlsRestored'])
  self.assertLess(events.index('preserve'),events.index('resume'))
  self.assertLess(events.index('resume'),events.index('verify-restored'))
 def test_failed_capacity_keeps_scheduling_paused(self):
  result,events=self.exercise(fail=True)
  self.assertEqual(result['status'],'failed');self.assertTrue(result['manualIntervention'])
  self.assertFalse(result['taskControlsRestored']);self.assertNotIn('resume',events)
 def test_static_release_does_not_touch_worker_capacity(self):
  result,events=self.exercise(static=True)
  self.assertEqual(result['status'],'deployed');self.assertNotIn('preserve',events)
  self.assertNotIn('pause',events)
