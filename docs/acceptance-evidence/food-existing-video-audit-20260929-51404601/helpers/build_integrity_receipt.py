from __future__ import annotations
import hashlib,json,subprocess
from pathlib import Path
AUDIT=Path(__file__).resolve().parent; REPO=Path(r'D:\autocut\video-auto-cut')
RUN=Path(r'D:\vac\f3\w\video\runs\20260929\f3\.videoautocut\runs\run_175e3315e0624f028eba293d66a9dece')
BASE=json.loads((REPO/r'docs\acceptance-evidence\food-e2e-shortroot-subtitle-stop-20260929-51403704\receipts\postrun-evidence.json').read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
protected=[
('VideoAutoCutDesktop/package.json','8c89f426c9c350b3388245a4ef077653d31cb8f155b7085ef4d59286dc0c3d91'),
('VideoAutoCutDesktop/package-lock.json','7e9958728343da5c85f96188c11f6e69aee5f7b3918ec23c89a7196abf398ec8'),
('VideoAutoCutDesktop/runtime-release/manifest.json','b92c9477703b91d503974881c103b0b35cb8878f819691caa28cdae764f99942'),
('VideoAutoCutDesktop/release-upload.local.json','d3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c'),
('D:/Video Edit/VideoAutoCut/config/app.env','b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab'),
('C:/Users/evstm/.pi/agent/models.json','c42af349bd0897e18b086c7f799442f7e08f2d3adb8639dba38fb08290dc822a')]
pc=[]
for name,expected in protected:
 p=Path(name) if Path(name).is_absolute() else REPO/name; actual=sha(p);pc.append({'path':name,'expected_sha256':expected,'actual_sha256':actual,'same':actual==expected})
ass=[]
for i,p in enumerate(sorted((RUN/'temp'/'ass').glob('*.ass'))):
 old=BASE['ass'][i];actual=sha(p);ass.append({'shot':i+1,'path':str(p),'sha256':actual,'baseline_sha256':old['sha256'],'unchanged':actual==old['sha256']})
shots=RUN/'shots.json'; original=Path(r'D:\vac\f3\shots.json')
out={'schema':'food-existing-video-integrity/v1','read_only':True,'pipeline_engine_spawns':0,'model_calls':0,'rerenders':0,'final_run_shots':{'path':str(shots),'bytes':shots.stat().st_size,'sha256':sha(shots)},'frozen_input_shots':{'path':str(original),'bytes':original.stat().st_size,'sha256':sha(original)},'ass':ass,'ass_unchanged_count':sum(x['unchanged'] for x in ass),'protections':pc,'protections_same_count':sum(x['same'] for x in pc),'git_status':subprocess.check_output(['git','status','--short'],cwd=REPO,text=True).splitlines(),'note':'New untracked docs package is expected during evidence assembly; two package files are the only pre-existing user modifications.'}
(AUDIT/'receipts'/'read-only-integrity.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'ass_unchanged':out['ass_unchanged_count'],'protected_same':out['protections_same_count'],'run_shots_sha256':out['final_run_shots']['sha256']}))
