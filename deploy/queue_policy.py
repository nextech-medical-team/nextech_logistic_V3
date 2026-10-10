"""Shared server FIFO and proof validation; no publication bypass."""
import hashlib,datetime

def blockers(local,automatic,current_id,created_at):
 def date(value):return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 def pending_request(r):
  if r['status']=='resolved':return r.get('resolution',{}).get('verified') is not True
  if r['status'] in ('ready','deploying','blocked'):return True
  report=r.get('report',{})
  return r['status']=='failed' and (r.get('requiresReplacement',True) or report.get('manualIntervention') or report.get('rollback')=='FAILED' or report.get('taskControlsRestored') is False)
 pending=[r for r in [*local,*automatic] if r['id']!=current_id and pending_request(r)]
 return sorted([r for r in pending if r['status']=='deploying' or date(r['createdAt'])<=date(created_at)],key=lambda r:(date(r['createdAt']),r['id']))

def validate_manifest(manifest,proofs,commit,changes):
 if manifest.get('ready') is not True or manifest.get('openGates')!=[]:raise ValueError('Gates de publication ouvertes')
 if manifest.get('git',{}).get('commit')!=commit or manifest.get('git',{}).get('pushVerified') is not True:raise ValueError('Commit des preuves différent')
 verification=manifest.get('verification',{})
 if verification.get('status')!='PASS' or verification.get('commit')!=commit:raise ValueError('Vérifications non confirmées')
 for kind in ('functional','performance','visualDesktop','visualMobile'):
  check=verification.get(kind,{})
  name=check.get('proofPath')
  if check.get('status')!='PASS' or name not in proofs or hashlib.sha256(proofs[name]).hexdigest()!=check.get('sha256'):raise ValueError('Preuve invalide : '+kind)
 expected={f['serverPath']:f['preparedSha256'] for f in manifest.get('files',[])}
 for changed in changes:
  if changed['after'] is not None and expected.get(changed['path'])!=changed['after']:raise ValueError('Fichier candidat sans preuve : '+changed['path'])
 return True
