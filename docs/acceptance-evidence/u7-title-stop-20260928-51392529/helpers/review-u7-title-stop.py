import json, re, hashlib
from pathlib import Path
from datetime import datetime

repo=Path(r'D:\autocut\video-auto-cut')
phase=repo/'VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928/phase-51391241-u7-1c307c3'
raw=phase/'raw-electron-stdout'
base='observer-38288-seq-2-child-39012'
meta_path=raw/(base+'-metadata.json')
meta=json.loads(meta_path.read_text(encoding='utf-8'))
hashof=lambda b: hashlib.sha256(b).hexdigest()
streams={}
for name, key in [('stdout','stdout'),('stderr','stderr'),('events','vacut_events')]:
    p=raw/meta[key]['path']; b=p.read_bytes()
    assert len(b)==meta[key]['bytes'] and hashof(b)==meta[key]['sha256']
    b.decode('utf-8',errors='strict')
    streams[name]={'path':str(p),'bytes':len(b),'sha256':hashof(b)}
assert meta['observer_pid']==38288 and meta['child_pid']==39012 and meta['exit_code']==0
assert meta['child_executable_basename']=='videoautocutengine.exe'
stdout=(raw/(base+'-stdout.bin')).read_bytes().decode('utf-8',errors='strict')
lines=[]
offset=0
for number,line in enumerate(stdout.splitlines(keepends=True),1):
    b=line.encode('utf-8'); lines.append({'number':number,'byte_offset':offset,'text':line.rstrip('\r\n'),'raw_sha256':hashof(b),'raw_utf8_base64':None})
    offset+=len(b)
assert offset==streams['stdout']['bytes']
marker=next(l['text'] for l in lines if l['text'].startswith('已生成分镜: '))
shots_path=Path(marker.split(': ',1)[1])
shots_bytes=shots_path.read_bytes(); plan=json.loads(shots_bytes.decode('utf-8'))
shots=plan['shots']; assert len(shots)==7
oracle_path=repo/'VideoAutoCutDesktop/node_modules/.tmp/w2-3715aa4-20260924-134913-prep/expected-author-fields/row-6.strict-validation.json'
oracle_bytes=oracle_path.read_bytes(); assert hashof(oracle_bytes)=='e8d132ead6801bf7b6ecda1ec1bd5169695a9969c281ea4b810353cc03d72cf0'
oracle=json.loads(oracle_bytes.decode('utf-8')); assert [r['shot'] for r in oracle['rows']]==list(range(1,8))
checks=[]; differences=[]
for expected,actual in zip(oracle['rows'],shots):
    for field,entry in expected['fields'].items():
        value=str(actual.get(field) or ''); present=bool(value)
        exact=present==entry['present'] and (not present or hashof(value.encode('utf-8'))==entry['expected_sha256'])
        row={'shot':expected['shot'],'field':field,'expected_present':entry['present'],'actual_present':present,'expected_sha256':entry['expected_sha256'],'actual_sha256':hashof(value.encode('utf-8')) if present else None,'expected_length':entry['expected_len'],'actual_length':len(value),'exact':exact}
        checks.append(row)
        if not exact: differences.append(dict(row,actual=value))
assert [(d['shot'],d['field']) for d in differences]==[(4,'title'),(6,'title')]
markers={}
for key,prefix in [('upload','AI 上传脚本文件:'),('upload_done','AI 脚本文件上传完成:'),('parse','AI 解析脚本文件:'),('voice_review','AI 复核口播字幕:'),('voice_review_done','AI 口播字幕复核完成:'),('normalize_done','AI 脚本规范化完成:')]:
    markers[key]=[l for l in lines if l['text'].startswith(prefix)]
assert len(markers['upload'])==len(markers['upload_done'])==len(markers['parse'])==len(markers['normalize_done'])==1
assert len(markers['voice_review'])==len(markers['voice_review_done'])==0
retries=[l for l in lines if re.search(r'\[警告\].*重试\s+\d+/\d+',l['text'])]
assert not retries
def language(text):
    han=len(re.findall(r'[\u3400-\u9fff]',text)); words=len(re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)*",text))
    return 'zh' if han and han>=words else 'en' if words else ''
contexts=[str(s.get('subtitle') or s.get('voice_text') or '').strip() for s in shots]
overall=language(' '.join(contexts)); predicates=[]
for s,context in zip(shots,contexts):
    lang=language(context) or overall
    # Every actual title has Han text; clean_label only splits separators,
    # and these seven titles contain no separator and never mutate in ensure_progress_labels.
    title=s['title']; assert not any(sep in title for sep in ('：',':','，',',','；',';','。'))
    sufficient=lang=='zh' and bool(re.search(r'[\u3400-\u9fff]',title))
    assert sufficient or not context or not lang
    predicates.append({'shot':s['shot'],'actual_title':title,'context_source':'subtitle' if s.get('subtitle') else 'voice_text','context_sha256':hashof(context.encode('utf-8')),'language':lang,'title_sufficient':sufficient,'pending_excluded':True})
assert len([p for p in raw.glob('observer-*-metadata.json')])==2
receipt={'kind':'root-independent-u7-title-STOP-review','reviewed_at':datetime.now().astimezone().isoformat(),'source_sha':'1c307c384a2ffaeed02bf29d5da55b671d3b59ab','gui_import_clicks':1,'engine_exit_code':0,'streams':streams,'metadata_sha256':hashof(meta_path.read_bytes()),'plan':{'path':str(shots_path),'bytes':len(shots_bytes),'sha256':hashof(shots_bytes),'shots':7},'author_fields':checks,'differences':differences,'markers':markers,'warning_lines':[l for l in lines if '只提示不纠正' in l['text']],'calls':{'file_upload_logical':1,'file_upload_http_attempts_source_derived':1,'main_parse_logical':1,'main_parse_model':'qwen-long','main_parse_http_attempts_source_derived':1,'voice_review_logical':0,'progress_label_review_logical_source_derived':0,'automatic_retry_warnings':0,'http_count_limit':'Successful low-level request starts are not separately logged; count combines frozen single-call workflow/source and complete retry-warning stream.'},'progress_label_predicates':predicates,'STOP_reason':'Strict authored-field comparison differs at shot4/title and shot6/title; current U7 incomplete, no legacy comparison or Food release.','legacy_calls':0,'food_generate':0,'W6':0,'product_or_input_or_gate_changed':False}
out=repo/'.codex-handoff/root-review-u7-title-stop-51392529.json'
out.write_bytes((json.dumps(receipt,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
print(json.dumps({'receipt':str(out),'sha256':hashof(out.read_bytes()),'streams':streams,'plan':receipt['plan'],'differences':differences,'calls':receipt['calls']},ensure_ascii=False))
