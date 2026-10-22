import base64,json,os,re,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import dispatcher as d

TOKEN='ghs_synthetic_test_credential_only'
class GitHubReadAuthTests(unittest.TestCase):
 def test_token_is_removed_from_packet_before_proofs_are_saved(self):
  packet,token=d.read_publication_packet(json.dumps({'manifest':{'commit':'a'*40},'proofs':{},'_githubReadToken':TOKEN}))
  self.assertEqual(token,TOKEN);self.assertNotIn(TOKEN,json.dumps(packet));self.assertNotIn('_githubReadToken',packet)
 def test_old_packets_remain_supported(self):
  self.assertEqual(d.read_publication_packet('{"proofs":{}}'),({'proofs':{}},None))
 def test_invalid_credentials_fail_without_echoing_them(self):
  for token in ['',42,{},'x'*4097,TOKEN+'\nInjected']:
   with self.assertRaisesRegex(ValueError,'temporaire invalide') as caught:d.read_publication_packet(json.dumps({'_githubReadToken':token}))
   self.assertNotIn(str(token),str(caught.exception)) if token else None
 def test_auth_is_scoped_to_the_exact_repo_and_not_global_environment(self):
  with patch.dict(os.environ,{'GIT_TRACE':'1','GIT_CURL_VERBOSE':'1','GIT_CONFIG_COUNT':'9','GIT_CONFIG_VALUE_8':'old'},clear=True):
   env=d.github_fetch_environment(TOKEN)
   self.assertNotIn('GIT_TRACE',env);self.assertNotIn('GIT_CURL_VERBOSE',env);self.assertNotIn('GIT_CONFIG_VALUE_8',env)
   settings={env['GIT_CONFIG_KEY_'+str(i)]:env['GIT_CONFIG_VALUE_'+str(i)] for i in range(int(env['GIT_CONFIG_COUNT']))}
   self.assertEqual(settings['credential.helper'],'');self.assertEqual(settings['http.followRedirects'],'false');self.assertEqual(settings['http.extraHeader'],'')
   header=settings['http.'+d.REMOTE+'.extraHeader']
   self.assertEqual(base64.b64decode(header.split()[-1]).decode(),'x-access-token:'+TOKEN)
   self.assertNotIn(TOKEN,str(dict(os.environ)));self.assertEqual(os.environ['GIT_CONFIG_COUNT'],'9')
 def test_fetch_and_clone_only_receive_ephemeral_environment(self):
  with tempfile.TemporaryDirectory() as td:
   repo=Path(td)/'repo'
   with patch.object(d,'REPO',repo),patch.object(d,'GITHUB_READ_TOKEN',TOKEN),patch.object(d,'run',return_value=b'a'*40+b'\n') as run:
    self.assertEqual(d.fetch(),'a'*40)
   self.assertEqual(len(run.call_args_list),3)
   for call in run.call_args_list[:2]:
    self.assertNotIn(TOKEN,str(call.args));self.assertIn(d.REMOTE,call.args[0]);self.assertIn('env',call.kwargs)
   self.assertNotIn('env',run.call_args_list[-1].kwargs)
   self.assertFalse(repo.exists())
 def test_git_failures_do_not_expose_credentials_or_raw_stderr(self):
  with tempfile.TemporaryDirectory() as td:
   for message,expected in [(b'Authentication failed '+TOKEN.encode(),'Accès GitHub refusé'),(b'Could not resolve host','réseau'),(b'fatal other '+TOKEN.encode(),'configuration Git')]:
    error=subprocess.CalledProcessError(128,['git'],stderr=message)
    with patch.object(d,'REPO',Path(td)),patch.object(d,'GITHUB_READ_TOKEN',TOKEN),patch.object(d,'run',side_effect=error):
     with self.assertRaisesRegex(RuntimeError,expected) as caught:d.fetch()
     self.assertNotIn(TOKEN,str(caught.exception));self.assertTrue(caught.exception.__suppress_context__)
 def test_workflow_streams_token_without_putting_it_in_artifacts(self):
  text=(Path(__file__).parents[1]/'.github/workflows/deploy.yml').read_text()
  self.assertIn('contents: read',text);self.assertIn('GITHUB_READ_TOKEN: ${{ github.token }}',text)
  self.assertIn('json.dump(p,sys.stdout)',text);self.assertNotIn('< publication-packet.json',text)
  self.assertNotIn('"deploy $TARGET_SHA" "$GITHUB_READ_TOKEN"',text)

 def test_git_resolves_header_only_for_expected_repository(self):
  version=tuple(map(int,re.search(r"(\d+)\.(\d+)",subprocess.check_output(["git","--version"],text=True)).groups()))
  if version<(2,31):self.skipTest("GIT_CONFIG_COUNT requires Git >= 2.31; production and CI use newer Git")
  env=d.github_fetch_environment(TOKEN)
  result=subprocess.run(['git','config','--get-urlmatch','http.extraheader',d.REMOTE],env=env,capture_output=True,text=True,check=True)
  self.assertIn('Authorization: Basic ',result.stdout)
  other=subprocess.run(['git','config','--get-urlmatch','http.extraheader','https://example.invalid/repository'],env=env,capture_output=True,text=True)
  self.assertNotIn('Authorization',other.stdout)
 def test_workflow_envelope_leaves_proof_artifact_unchanged(self):
  workflow=(Path(__file__).parents[1]/'.github/workflows/deploy.yml').read_text()
  command=workflow.split("python3 -c '")[1].split("' | ")[0]
  with tempfile.TemporaryDirectory() as td:
   path=Path(td)/'publication-packet.json';original=b'{"manifest":{},"proofs":{}}';path.write_bytes(original)
   result=subprocess.run(['python3','-c',command],cwd=td,env={**os.environ,'GITHUB_READ_TOKEN':TOKEN},capture_output=True,check=True)
   packet,token=d.read_publication_packet(result.stdout)
   self.assertEqual(token,TOKEN);self.assertEqual(packet,json.loads(original));self.assertEqual(path.read_bytes(),original)
