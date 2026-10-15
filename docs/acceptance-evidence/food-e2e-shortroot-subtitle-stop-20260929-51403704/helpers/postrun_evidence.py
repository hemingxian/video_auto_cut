from __future__ import annotations
import hashlib, json, subprocess
from pathlib import Path

ROOT=Path(r"D:\vac\f3")
REPO=Path(r"D:\autocut\video-auto-cut")
RUN=ROOT/r"w\video\runs\20260929\f3\.videoautocut\runs\run_175e3315e0624f028eba293d66a9dece"
def sha(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for c in iter(lambda:f.read(1024*1024),b''): h.update(c)
    return h.hexdigest()
def meta(p):
    p=Path(p); return {'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)}

artifacts=[]
plan=json.loads((ROOT/'shots.json').read_text(encoding='utf-8'))
shot_order={s['shot_id']:i for i,s in enumerate(plan['shots'],1)}
for i in range(1,10):
    inc=list(Path('\\\\?\\'+str(RUN/'incremental-work')).rglob('0001_asr_result.json'))
    # Bind incremental result by shot_id through its sibling shots.json.
    match=[]
    for a in inc:
        s=json.loads((a.parents[1]/'shots.json').read_text(encoding='utf-8'))
        shot=(s.get('shots') or [s])[0]
        if shot_order.get(shot.get('shot_id'))==i: match.append(a)
    artifacts.append({'shot':i,'voice':meta(RUN/'voice'/f'{i:04d}_voice.mp3'),'cue':meta(RUN/'voice'/f'{i:04d}_cues.json'),'asr_candidates':[meta(x) for x in match]})

pack=[]
for f in sorted((RUN/'final_clips'/'packaging').glob('*/packaging-agent-log.json')):
    j=json.loads(f.read_text(encoding='utf-8'))
    pack.append({'shot_dir':f.parent.name,'source':meta(f),'backend':j.get('backend'),'policy':j.get('policy'),'response_raw_is_null':j.get('response_raw') is None,'deterministic':j.get('deterministic'),'decision':j.get('decision')})

observer=json.loads((ROOT/'actual-process-environment.json').read_text(encoding='utf-8'))
vals={k:sorted({r.get(k) for r in observer['records'] if r.get(k)}) for k in ('TEMP','TMP','VIDEOAUTO_TEMP_DIR')}
engine_record=next(r for r in observer['records'] if r.get('pid')==6464)
first_python=sorted((r for r in observer['records'] if str(r.get('image','')).lower().endswith('python.exe') and r.get('parent_pid')==6464),key=lambda r:r['captured_at'])[0]
actual_packaging=[]
for d in sorted((RUN/'final_clips'/'packaging').iterdir()):
    if d.is_dir():
        raw=str(d); extended='\\\\?\\'+raw
        actual_packaging.append({'shot_dir':d.name,'without_prefix':raw,'without_prefix_length':len(raw),'passed_form':extended,'passed_form_length':len(extended),'exists':d.exists()})

protected=[
('VideoAutoCutDesktop/package.json','8c89f426c9c350b3388245a4ef077653d31cb8f155b7085ef4d59286dc0c3d91'),
('VideoAutoCutDesktop/package-lock.json','7e9958728343da5c85f96188c11f6e69aee5f7b3918ec23c89a7196abf398ec8'),
('VideoAutoCutDesktop/runtime-release/manifest.json','b92c9477703b91d503974881c103b0b35cb8878f819691caa28cdae764f99942'),
('VideoAutoCutDesktop/release-upload.local.json','d3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c'),
('D:/Video Edit/VideoAutoCut/config/app.env','b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab'),
('C:/Users/evstm/.pi/agent/models.json','c42af349bd0897e18b086c7f799442f7e08f2d3adb8639dba38fb08290dc822a')]
checks=[]
for name,expected in protected:
    p=Path(name) if Path(name).is_absolute() else REPO/name; actual=sha(p)
    checks.append({'path':name,'expected_sha256':expected,'actual_sha256':actual,'same':actual==expected})

final=json.loads((RUN/'final_video.json').read_text(encoding='utf-8'))
final_path=Path(final['path'].removeprefix('\\\\?\\'))
out={'schema':'food-shortroot-postrun/v1','run':str(RUN),'formal_result':json.loads((ROOT/'formal-result.json').read_text()),'final_video':meta(final_path),'final_clips':[meta(x) for x in sorted((RUN/'final_clips').glob('*_final.mp4'))],'ass':[meta(x) for x in sorted((RUN/'temp'/'ass').glob('*.ass'))],'fresh_artifacts':artifacts,'packaging_decisions':pack,'actual_packaging_paths':actual_packaging,'observer':{'status':observer.get('status'),'records':len(observer['records']),'capture_errors':len(observer['capture_errors']),'values_all_observer_records_unfiltered':vals,'formal_engine_record':engine_record,'first_direct_python_record':first_python,'scope_limit':'Observer inventory includes unrelated long-lived processes such as codex.exe; aggregate values are not asserted as formal-child-only. Engine and first direct Python records are the authoritative launch facts.','receipt':meta(ROOT/'actual-process-environment.json')},'protections':checks,'git_status':subprocess.check_output(['git','status','--short'],cwd=REPO,text=True).splitlines()}
(ROOT/'postrun-evidence.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'final':out['final_video'],'clips':len(out['final_clips']),'ass':len(out['ass']),'packaging_logs':len(pack),'observer_records':out['observer']['records'],'observer_status':out['observer']['status'],'protections_same':sum(x['same'] for x in checks),'git_status':out['git_status']},ensure_ascii=False))
