import unittest,hashlib
from queue_policy import blockers,validate_manifest
class QueueTests(unittest.TestCase):
 def test_earlier_ready_and_blocked_cannot_be_overtaken(self):
  local=[{'id':'old','status':'blocked','createdAt':'2026-01-01'},{'id':'new','status':'ready','createdAt':'2026-01-03'}]
  self.assertEqual([r['id'] for r in blockers(local,[],'ci','2026-01-02')],['old'])
 def test_active_always_blocks_and_terminal_does_not(self):
  rows=[{'id':'active','status':'deploying','createdAt':'2026-01-03'},{'id':'done','status':'deployed','createdAt':'2026-01-01'}]
  self.assertEqual([r['id'] for r in blockers(rows,[],'ci','2026-01-02')],['active'])
 def test_failed_rollback_or_required_replacement_blocks_next_push(self):
  for report in ({'rollback':'FAILED','manualIntervention':True},{'taskControlsRestored':False},{'status':'failed'}):
   old={'id':'old','status':'failed','createdAt':'2026-01-01','requiresReplacement':True,'report':report}
   self.assertEqual([r['id'] for r in blockers([], [old], 'next', '2026-01-02')],['old'])
 def test_only_verified_resolved_record_can_leave_fifo(self):
  old={'id':'old','status':'resolved','createdAt':'2026-01-01','resolution':{'verified':True},'report':{'manualIntervention':True}}
  self.assertEqual(blockers([],[old],'next','2026-01-02'),[])
  del old['resolution'];self.assertEqual([r['id'] for r in blockers([],[old],'next','2026-01-02')],['old'])
 def test_gates_and_proofs_are_revalidated(self):
  raw=b'isolated-proof';sha=hashlib.sha256(raw).hexdigest();commit='a'*40
  manifest={'ready':True,'openGates':[],'git':{'commit':commit,'pushVerified':True},'verification':{'status':'PASS','commit':commit,**{k:{'status':'PASS','proofPath':'proof','sha256':sha} for k in ('functional','performance','visualDesktop','visualMobile')}},'files':[{'serverPath':'public/app.js','preparedSha256':sha}]}
  self.assertTrue(validate_manifest(manifest,{'proof':raw},commit,[{'path':'public/app.js','after':sha}]))
  for mutation in ('gate','commit','proof','candidate'):
   import copy
   m=copy.deepcopy(manifest);proofs={'proof':raw};changes=[{'path':'public/app.js','after':sha}]
   if mutation=='gate':m['openGates']=['remaining']
   if mutation=='commit':m['verification']['commit']='b'*40
   if mutation=='proof':proofs['proof']=b'modified'
   if mutation=='candidate':changes[0]['after']='c'*64
   with self.assertRaises(ValueError):validate_manifest(m,proofs,commit,changes)

 def test_pending_recipe_is_never_implicitly_overtaken(self):
  recipe={'id':'recipe','status':'recipe_pending','createdAt':'2026-01-03','publication':{'status':'verified'}}
  self.assertEqual(blockers([recipe],[],'next','2026-01-02'),[recipe])
