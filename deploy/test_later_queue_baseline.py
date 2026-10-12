import unittest
from queue_bridge import later_baseline_allowed
class LaterBaseline(unittest.TestCase):
 def fixture(self):return {'report':{'baselineCommitBefore':'old','installed':False,'paused':False}}, {'commit':'new','serverHashes':{'src/a':'hash'}}
 def test_verified_descendant_preinstall_failure(self):
  r,b=self.fixture();self.assertTrue(later_baseline_allowed(r,b,lambda a,z:(a,z)==('old','new')))
 def test_non_descendant_refused(self):
  r,b=self.fixture();self.assertFalse(later_baseline_allowed(r,b,lambda *_:False))
 def test_missing_or_unsafe_state_refused(self):
  for key,value in [('installed',True),('installed',None),('paused',True),('paused',None),('manualIntervention',True),('rollback','FAILED'),('taskControlsRestored',False)]:
   r,b=self.fixture();r['report'][key]=value;self.assertFalse(later_baseline_allowed(r,b,lambda *_:True))
 def test_missing_hashes_refused(self):
  r,b=self.fixture();b['serverHashes']={};self.assertFalse(later_baseline_allowed(r,b,lambda *_:True))

class RealCertificate(unittest.TestCase):
 def test_current_publication_hashes_environment_and_health_are_required(self):
  import tempfile,json
  from pathlib import Path
  from unittest.mock import patch
  import queue_bridge as bridge,dispatcher
  data=b'new published bytes';sha=dispatcher.digest(data)
  with tempfile.TemporaryDirectory() as td:
   state=Path(td);(state/'baseline.json').write_text(json.dumps({'commit':'b'*40,'serverHashes':{'public/app.js':sha},'environmentHash':'env'}))
   record={'report':{'baselineCommitBefore':'a'*40,'installed':False,'paused':False,'files':[{'path':'public/app.js','before':'old'}]}}
   with patch.object(bridge,'STATE',state),patch.object(dispatcher,'git',return_value=b''),patch.object(dispatcher,'read_current',return_value={'public/app.js':data}) as current,patch.object(dispatcher,'verify_environment',return_value='env') as env,patch.object(dispatcher,'health') as health:
    result=bridge.restoration_certificate(record);self.assertTrue(result['verified']);self.assertEqual(result['previousCommit'],'b'*40);self.assertEqual(result['fileHashes'],{'public/app.js':sha})
    current.return_value={'public/app.js':b'wrong'}
    with self.assertRaises(ValueError):bridge.restoration_certificate(record)
    current.return_value={'public/app.js':data};env.return_value='wrong'
    with self.assertRaises(ValueError):bridge.restoration_certificate(record)
    env.return_value='env';health.side_effect=ValueError('unhealthy')
    with self.assertRaises(ValueError):bridge.restoration_certificate(record)

if __name__=='__main__':unittest.main()
