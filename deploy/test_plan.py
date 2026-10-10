import unittest
from plan import plan,digest

class PlanTests(unittest.TestCase):
 def test_exact_targeted_change(self):
  before={'public/app.js':b'old','src/private.json':b'{}'}
  current={'public/app.js':b'old','src/private.json':b'PRIVATE'}
  result=plan(before,{'public/app.js':b'new','src/private.json':b'{}'},current,{k:digest(v) for k,v in current.items()})
  self.assertEqual([x['path'] for x in result],['public/app.js'])
 def test_drift_rejected(self):
  with self.assertRaisesRegex(ValueError,'Conflit'):plan({'src/x.mjs':b'old'},{'src/x.mjs':b'new'},{'src/x.mjs':b'colleague'},{'src/x.mjs':digest(b'old')})
 def test_private_export_rejected(self):
  with self.assertRaisesRegex(ValueError,'privée'):plan({'src/x.mjs':b'sanitized'},{'src/x.mjs':b'new'},{'src/x.mjs':b'private'},{'src/x.mjs':digest(b'private')})
 def test_new_conflict(self):
  with self.assertRaisesRegex(ValueError,'non suivi'):plan({}, {'src/x.mjs':b'new'},{'src/x.mjs':b'existing'},{'src/x.mjs':digest(b'existing')})
 def test_crlf_accepted_without_overwriting_others(self):
  self.assertEqual(len(plan({'public/x.js':b'old\r\n'},{'public/x.js':b'new\n'},{'public/x.js':b'old\n'},{'public/x.js':digest(b'old\n')})),1)
 def test_traversal(self):
  with self.assertRaisesRegex(ValueError,'Chemin'):plan({}, {'src/../../etc/file':b'new'},{},{})
 def test_deletion(self):
  self.assertIsNone(plan({'public/old.js':b'old'},{},{'public/old.js':b'old'},{'public/old.js':digest(b'old')})[0]['after'])
if __name__=='__main__':unittest.main()
