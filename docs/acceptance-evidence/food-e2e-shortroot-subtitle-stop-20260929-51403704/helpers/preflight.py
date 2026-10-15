#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, subprocess
from datetime import datetime, timezone
from pathlib import Path

AUDIT=Path(__file__).resolve().parent
STATE=json.loads((AUDIT/'formal-state.json').read_text(encoding='utf-8'))
REPO=Path(STATE['repo']); RUNTIME=Path(STATE['runtime'])
def sha(p: Path)->str:
    h=hashlib.sha256()
    with p.open('rb') as f:
        for c in iter(lambda:f.read(1024*1024),b''): h.update(c)
    return h.hexdigest()
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
status=subprocess.check_output(['git','status','--short'],cwd=REPO,text=True).splitlines()
plan=Path(STATE['plan']); manifest_path=Path(STATE['manifest']); manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
materials={m['material_id']:m for s in manifest['shots'] for m in s['materials']}
previous=json.loads((AUDIT/'preflight-receipt.json').read_text(encoding='utf-8')) if (AUDIT/'preflight-receipt.json').exists() else None
if previous and len(previous.get('materials',[]))==6 and all(x.get('same') for x in previous['materials']): material_checks=previous['materials']; material_hash_source='same-run initial preflight receipt'
else:
    material_checks=[]; material_hash_source='fresh hash'
    for material_id,m in sorted(materials.items()):
        p=Path(m['local_path']); actual=sha(p) if p.is_file() else None
        material_checks.append({'material_id':material_id,'exists':p.is_file(),'expected_sha256':m['source_sha256'],'actual_sha256':actual,'same':actual==m['source_sha256']})
tracked_tools=subprocess.check_output(['git','ls-tree','-r','--name-only',head,'--','VideoAutoCut/tools'],cwd=REPO,text=True).splitlines()
repo_tools={name.removeprefix('VideoAutoCut/tools/'):sha(REPO/name) for name in tracked_tools}
runtime_tools={rel:sha(RUNTIME/'tools'/rel) if (RUNTIME/'tools'/rel).is_file() else None for rel in repo_tools}
auth_path=Path(STATE['env']).parent/'auth.json'; auth=json.loads(auth_path.read_text(encoding='utf-8'))
expiry=auth.get('expiresAt') or auth.get('expires_at') or auth.get('expiresAtUtc')
expiry_dt=None
if isinstance(expiry,(int,float)): expiry_dt=datetime.fromtimestamp(expiry/1000 if expiry>10_000_000_000 else expiry,tz=timezone.utc)
elif isinstance(expiry,str): expiry_dt=datetime.fromisoformat(expiry.replace('Z','+00:00'))
protected=[
 ('VideoAutoCutDesktop/package.json','8c89f426c9c350b3388245a4ef077653d31cb8f155b7085ef4d59286dc0c3d91'),
 ('VideoAutoCutDesktop/package-lock.json','7e9958728343da5c85f96188c11f6e69aee5f7b3918ec23c89a7196abf398ec8'),
 ('VideoAutoCutDesktop/runtime-release/manifest.json','b92c9477703b91d503974881c103b0b35cb8878f819691caa28cdae764f99942'),
 ('VideoAutoCutDesktop/release-upload.local.json','d3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c'),
 ('D:/Video Edit/VideoAutoCut/config/app.env','b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab'),
 ('C:/Users/evstm/.pi/agent/models.json','c42af349bd0897e18b086c7f799442f7e08f2d3adb8639dba38fb08290dc822a')]
protection=[]
for name,expected in protected:
    p=Path(name) if Path(name).is_absolute() else REPO/name; actual=sha(p)
    protection.append({'path':name,'expected_sha256':expected,'actual_sha256':actual,'same':actual==expected})
fresh={k:{'exists':Path(STATE[k]).exists(),'empty':Path(STATE[k]).is_dir() and not any(Path(STATE[k]).iterdir())} for k in ('workspace','output','temp','pi_agent','appdata')}
date_token=datetime.now(timezone.utc).strftime('%Y%m%d')
estimated_cwd=Path(STATE['workspace'])/'video'/'runs'/date_token/STATE['project_name']/'.videoautocut'/'runs'/STATE['run_id']/'final_clips'/'packaging'/'0009_final'
estimated_extended='\\\\?\\'+str(estimated_cwd)
path_estimate={'short_root':str(AUDIT),'short_root_length':len(str(AUDIT)),'cwd_without_prefix':str(estimated_cwd),'cwd_without_prefix_length':len(str(estimated_cwd)),'cwd_passed_to_subprocess':estimated_extended,'cwd_passed_to_subprocess_length':len(estimated_extended),'short_root_max':20,'cwd_max':200,'pass':len(str(AUDIT))<=20 and len(str(estimated_cwd))<=200 and len(estimated_extended)<=200}
result={'schema':'food-route-a-shortroot-preflight/v1','created_at':datetime.now(timezone.utc).isoformat(),'formal_spawn_count_new_run':0,'historical_formal_runs':2,
 'head':head,'branch':subprocess.check_output(['git','branch','--show-current'],cwd=REPO,text=True).strip(),'dirty':status,
 'engine_sha256':sha(RUNTIME/'VideoAutoCutEngine.exe'),'plan_sha256':sha(plan),'manifest_sha256':sha(manifest_path),'manifest_run_id':manifest['run_id'],'shots':len(manifest['shots']),
 'fixture_sha256':sha(REPO/'docs/script-template-v1/示例_食品码垛_v1.xlsx'),
 'tools':{'tracked_count':len(repo_tools),'runtime_checked_count':len(runtime_tools),'same':repo_tools==runtime_tools,'different':[k for k in repo_tools if repo_tools[k]!=runtime_tools[k]]},
 'materials':material_checks,'material_unique_count':len(materials),'material_hash_source':material_hash_source,'six_protections':protection,'fresh_roots':fresh,'path_estimate':path_estimate,
 'auth':{'valid_at_check':bool(expiry_dt and expiry_dt>datetime.now(timezone.utc)),'expires_at_utc':expiry_dt.isoformat().replace('+00:00','Z') if expiry_dt else None,'secret_values_recorded':False},
 'oracle':{'path':'../food-rerun-51402638-independent/source-54-field-oracle.json','sha256':'b94b4817b9fbdd4f75ff16c1dd8947b094e6f531e40915aadb8455d2118d5a94','not_rerun':True},
 'engine_or_model_started':False}
result['ok']=head=='665cdc0c89e43dbe0b218d7dcb5ebcf91c599017' and status==[' M VideoAutoCutDesktop/package-lock.json',' M VideoAutoCutDesktop/package.json'] and result['engine_sha256']=='be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf' and result['fixture_sha256']=='33a47aefc3d6e97d7cb556f827cfccbbac9dd2aba8e9cb35ae227b165869cc0a' and result['plan_sha256']==STATE['plan_sha256'] and result['manifest_sha256']==STATE['manifest_sha256'] and result['tools']['tracked_count']==157 and result['tools']['same'] and len(materials)==6 and all(x['same'] for x in protection+material_checks) and result['auth']['valid_at_check'] and all(not x['exists'] for x in fresh.values()) and path_estimate['pass']
(AUDIT/'preflight-receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'ok':result['ok'],'head':head,'dirty':status,'fixture_sha256':result['fixture_sha256'],'tools':result['tools'],'materials_same':sum(x['same'] for x in material_checks),'material_unique_count':len(materials),'material_hash_source':material_hash_source,'protections_same':sum(x['same'] for x in protection),'auth':result['auth'],'fresh_roots':fresh,'path_estimate':path_estimate,'engine_or_model_started':False},ensure_ascii=False))
raise SystemExit(0 if result['ok'] else 2)
