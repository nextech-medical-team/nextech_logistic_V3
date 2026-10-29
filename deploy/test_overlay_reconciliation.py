import unittest
from plan import digest,plan,reconcile_overlay_sources

class OverlayTests(unittest.TestCase):
 def setUp(self):
  self.name='public/compact-problems.js';self.sha='a'*40
  self.base=b'header\nstock_wait_visible\nseparator\ncustomer_duplicates\nfooter\n'
  self.overlay=self.base.replace(b'stock_wait_visible',b'stock_wait_hidden')
  self.candidate=self.overlay.replace(b'customer_duplicates',b'customer_grouped')
  self.baseline={'serverHashes':{self.name:digest(self.overlay)},'reconciliation':{'preservedOverlays':{self.name:{'sourceCommit':self.sha,'sha256':digest(self.overlay)}}}}
 def reconcile(self,candidate=None,current=None,source=None):
  return reconcile_overlay_sources({self.name:self.base},{self.name:self.candidate if candidate is None else candidate},{self.name:self.overlay if current is None else current},self.baseline,lambda sha,name:self.overlay if source is None else source)
 def test_preserves_overlay_and_new_change_without_mutation(self):
  original=repr(self.baseline);old,proof=self.reconcile()
  self.assertEqual(old[self.name],self.overlay);self.assertTrue(proof[0]['candidatePreservesOverlay']);self.assertEqual(original,repr(self.baseline))
  changes=plan(old,{self.name:self.candidate},{self.name:self.overlay},self.baseline['serverHashes'])
  self.assertEqual(changes[0]['before'],digest(self.overlay))
 def test_lost_server_fix_rejected(self):
  with self.assertRaisesRegex(ValueError,'non preserve'):self.reconcile(candidate=self.base.replace(b'customer_duplicates',b'customer_grouped'))
 def test_concurrent_server_edit_rejected(self):
  with self.assertRaisesRegex(ValueError,'Conflit'):self.reconcile(current=self.overlay+b'new edit')
 def test_git_provenance_mismatch_rejected(self):
  with self.assertRaisesRegex(ValueError,'Git overlay'):self.reconcile(source=b'other source')
 def test_missing_metadata_retains_private_source_guard(self):
  self.baseline.pop('reconciliation');old,proof=self.reconcile();self.assertFalse(proof)
  with self.assertRaisesRegex(ValueError,'divergente'):plan(old,{self.name:self.candidate},{self.name:self.overlay},self.baseline['serverHashes'])
 def test_conflicting_candidate_rejected(self):
  with self.assertRaisesRegex(ValueError,'non preserve'):self.reconcile(candidate=self.base.replace(b'stock_wait_visible',b'different_policy'))
 def test_baseline_hash_mismatch_rejected(self):
  self.baseline['serverHashes'][self.name]=digest(b'other')
  with self.assertRaisesRegex(ValueError,'Conflit'):self.reconcile()
 def test_deletion_of_overlay_rejected(self):
  with self.assertRaisesRegex(ValueError,'invalide'):reconcile_overlay_sources({self.name:self.base},{},{self.name:self.overlay},self.baseline,lambda *args:self.overlay)
 def test_compact_javascript_preserves_independent_changes_on_same_line(self):
  self.base=b"const add=p=>{if(a)return;const types=['stock'];};\n"
  self.overlay=b"const hidden='wait';\nconst add=p=>{if(p===hidden)return;if(a)return;const types=['stock'];};\n"
  self.candidate=self.overlay.replace(b"['stock']",b"['stock','customer']")
  self.baseline['serverHashes'][self.name]=digest(self.overlay)
  self.baseline['reconciliation']['preservedOverlays'][self.name]['sha256']=digest(self.overlay)
  self.assertTrue(self.reconcile()[1])
 def test_adopts_verified_server_only_file_without_installing_or_mutating_baseline(self):
  original=repr(self.baseline)
  old,proof=reconcile_overlay_sources({},{self.name:self.overlay},{self.name:self.overlay},self.baseline,lambda *args:self.overlay)
  self.assertEqual(old[self.name],self.overlay);self.assertTrue(proof[0]['candidatePreservesOverlay'])
  self.assertEqual(plan(old,{self.name:self.overlay},{self.name:self.overlay},self.baseline['serverHashes']),[])
  self.assertEqual(original,repr(self.baseline))
 def test_server_only_file_with_changed_candidate_is_rejected(self):
  with self.assertRaisesRegex(ValueError,'non preserve'):
   reconcile_overlay_sources({},{self.name:self.candidate},{self.name:self.overlay},self.baseline,lambda *args:self.overlay)
 def test_server_only_file_requires_current_and_git_provenance(self):
  for current,source in [(b'changed',self.overlay),(self.overlay,b'changed')]:
   with self.assertRaises(ValueError):
    reconcile_overlay_sources({},{self.name:self.overlay},{self.name:current},self.baseline,lambda *args:source)
if __name__=='__main__':unittest.main()
