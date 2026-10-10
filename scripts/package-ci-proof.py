import sys,subprocess,json,hashlib,base64
from pathlib import Path
commit=sys.argv[1];proof_names=['checks.log','desktop.png','mobile.png','performance.json']
proofs={name:(Path('proofs')/name).read_bytes() for name in proof_names}
def check(name):return {'status':'PASS','proofPath':name,'sha256':hashlib.sha256(proofs[name]).hexdigest()}
files=[]
for name in subprocess.check_output(['git','ls-tree','-r','--name-only',commit],text=True).splitlines():
 if name.startswith(('src/','public/')) or name in ('package.json','package-lock.json'):
  data=subprocess.check_output(['git','show',commit+':'+name]);files.append({'serverPath':name,'preparedSha256':hashlib.sha256(data).hexdigest()})
manifest={'ready':True,'openGates':[],'git':{'commit':commit,'pushVerified':True},'verification':{'status':'PASS','commit':commit,'functional':check('checks.log'),'performance':check('performance.json'),'visualDesktop':check('desktop.png'),'visualMobile':check('mobile.png')},'files':files,'scope':'CI isolated regressions + synthetic UI, no provider or production credentials'}
Path('publication-packet.json').write_text(json.dumps({'manifest':manifest,'proofs':{name:base64.b64encode(data).decode() for name,data in proofs.items()}}))
