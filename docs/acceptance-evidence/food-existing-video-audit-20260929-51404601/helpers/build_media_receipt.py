from __future__ import annotations
import hashlib,json
from pathlib import Path

AUDIT=Path(__file__).resolve().parent
RUN=Path(r'D:\vac\f3\w\video\runs\20260929\f3\.videoautocut\runs\run_175e3315e0624f028eba293d66a9dece')
FINAL=Path(r'D:\vac\f3\w\video\runs\20260929\f3\f3最终视频\f3_v001.mp4')
BASE=json.loads(Path(r'D:\autocut\video-auto-cut\docs\acceptance-evidence\food-e2e-shortroot-subtitle-stop-20260929-51403704\receipts\postrun-evidence.json').read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def probe(n): return json.loads((AUDIT/'receipts'/n).read_text(encoding='utf-8-sig'))

clips=[]; offset=0.0
for i in range(1,10):
    p=RUN/'final_clips'/f'{i:04d}_final.mp4'; j=probe(f'clip-{i:02d}-ffprobe.json')
    duration=float(j['format']['duration']); video=next(x for x in j['streams'] if x['codec_type']=='video')
    old=BASE['final_clips'][i-1]
    clips.append({'shot':i,'path':str(p),'sha256':sha(p),'baseline_sha256':old['sha256'],'unchanged':sha(p)==old['sha256'],'duration':duration,'video_duration':float(video['duration']),'global_start':offset,'global_end':offset+duration})
    offset+=duration
fj=probe('final-ffprobe.json'); video=next(x for x in fj['streams'] if x['codec_type']=='video'); audio=next(x for x in fj['streams'] if x['codec_type']=='audio')
frames=[]
for p in sorted((AUDIT/'frames').glob('*.png')): frames.append({'name':p.name,'bytes':p.stat().st_size,'sha256':sha(p)})
concat=RUN/'temp'/'concat'/'f3_v001_6464_concat_list.txt'
requested=((1,4.0),(2,2.0),(2,6.0),(5,4.8),(8,4.0))
mapping=[{'shot':shot,'local':local,'global':clips[shot-1]['global_start']+local} for shot,local in requested]
expected_names={f"final-shot{x['shot']:02d}-local-{x['local']:.1f}s-global-{x['global']:.3f}s.png" for x in mapping}
assert expected_names=={x['name'] for x in frames},(expected_names,{x['name'] for x in frames})
out={'schema':'food-media-51404601/v1','read_only':True,'engine_or_model_calls':0,'rerender':False,'final':{'path':str(FINAL),'bytes':FINAL.stat().st_size,'sha256':sha(FINAL),'baseline_sha256':BASE['final_video']['sha256'],'unchanged':sha(FINAL)==BASE['final_video']['sha256'],'format_duration':float(fj['format']['duration']),'video':{'codec':video['codec_name'],'width':video['width'],'height':video['height'],'r_frame_rate':video['r_frame_rate'],'avg_frame_rate':video['avg_frame_rate'],'duration':float(video['duration'])},'audio':{'codec':audio['codec_name'],'sample_rate':int(audio['sample_rate']),'channels':audio['channels'],'duration':float(audio['duration'])}},'clips':clips,'clip_duration_sum':offset,'concat':{'path':str(concat),'sha256':sha(concat),'entries':concat.read_text(encoding='utf-8').count("file '") ,'order_matches_0001_through_0009':all(f'{i:04d}_final.mp4' in line for i,line in enumerate(concat.read_text(encoding='utf-8').splitlines(),1))},'requested_frame_mapping':mapping,'frame_filename_mapping_asserted':True,'frames':frames,'scope':'Media specification, exact concat offsets, and specified frame evidence only. Human visual review is a separate receipt. Nine-ASS corrected-oracle validation is owned by source_facts.'}
(AUDIT/'receipts'/'media-acceptance.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'final':out['final'],'clip_sum':offset,'clips_unchanged':sum(x['unchanged'] for x in clips),'frames':frames},ensure_ascii=False))
