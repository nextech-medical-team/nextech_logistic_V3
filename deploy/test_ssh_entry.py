import os,subprocess,tempfile,unittest
from pathlib import Path

@unittest.skipIf(os.name=='nt','Bash testé sur les runners Linux')
class SSHEntryTests(unittest.TestCase):
 def test_syntax_and_command_restriction(self):
  script=Path(__file__).with_name('ssh-entry.sh')
  subprocess.run(['bash','-n',str(script)],check=True)
  with tempfile.TemporaryDirectory() as td:
   sudo=Path(td)/'sudo';sudo.write_text('#!/bin/bash\nprintf "%s\\n" "$@"\n');sudo.chmod(0o755)
   for command in ['','bash','deploy '+('a'*40)+'; echo leaked','deploy ../bad','deploy '+('a'*40)+' extra']:
    result=subprocess.run(['bash',str(script)],env={'PATH':td+':/usr/bin:/bin','SSH_ORIGINAL_COMMAND':command},capture_output=True,text=True)
    self.assertEqual(result.returncode,64);self.assertEqual(result.stdout,'')
   valid=subprocess.run(['bash',str(script)],env={'PATH':td+':/usr/bin:/bin','SSH_ORIGINAL_COMMAND':'deploy '+('a'*40)},capture_output=True,text=True)
   self.assertEqual(valid.returncode,0)
   self.assertEqual(valid.stdout.splitlines(),['-n','/usr/local/lib/nextech-cicd/dispatcher.py','deploy','a'*40])
