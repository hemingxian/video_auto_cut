import pathlib, json, re, hashlib, datetime, subprocess
root=pathlib.Path.cwd()
audit=root/'VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928'
raw=audit/'raw-electron-stdout'
meta=json.loads((raw/'observer-38016-seq-2-child-10176-metadata.json').read_text(encoding='utf-8'))
def sha(b): return hashlib.sha256(b).hexdigest()
streams={k:(raw/meta[k]['path']).read_bytes() for k in ['stdout','stderr','vacut_events']}
for k,b in streams.items():
 assert sha(b)==meta[k]['sha256'] and len(b)==meta[k]['bytes']
out=streams['stdout'].decode('utf-8','strict');err=streams['stderr'].decode('utf-8','strict')
lines=out.splitlines(keepends=True)
evlines=[x for x in lines if x.startswith('VACUT_EVENT:')]
assert len(evlines)==1 and ''.join(evlines).encode()==streams['vacut_events']
payload=json.loads(evlines[0][len('VACUT_EVENT:'):]);report=payload['scriptImport']
ai=[x for x in lines if 'AI' in x];normal=[x for x in ai if not x.startswith('VACUT_EVENT:')]
pattern=re.compile(r'^\[script\] 标准模板导入 ai_suggested: ([A-Z]+[0-9]+) 制作字段为 AI 建议$')
assert len(normal)==43 and all(pattern.fullmatch(x.rstrip('\r\n')) for x in normal)
warns=report['warnings'];counts={c:sum(w['code']==c for w in warns) for c in {w['code'] for w in warns}}
assert counts=={'ai_suggested':43,'status_pending':8,'status_note':2}
assert sorted(pattern.fullmatch(x.rstrip('\r\n'))[1] for x in normal)==sorted(w['cell'] for w in warns if w['code']=='ai_suggested')
def leaves(x,p=''):
 if isinstance(x,str):yield p,x
 elif isinstance(x,dict):
  for k,v in x.items():yield from leaves(v,p+'.'+k if p else k)
 elif isinstance(x,list):
  for i,v in enumerate(x):yield from leaves(v,p+f'[{i}]')
ai_leaves=[(p,v) for p,v in leaves(payload) if 'AI' in v]
assert len(ai_leaves)==43
for p,v in ai_leaves:
 m=re.fullmatch(r'scriptImport\.warnings\[(\d+)\]\.message',p)
 assert m and v=='制作字段为 AI 建议' and warns[int(m[1])]['code']=='ai_suggested'
model_hits=re.findall(r'qwen|dashscope|百炼|AI\s*上传脚本文件|AI\s*解析脚本文件',out+'\n'+err,re.I)
assert not model_hits
fixture=(root/'VideoAutoCutDesktop/tests/fixtures/u6-template-import-event.txt').read_bytes()
identical=streams['vacut_events'].rstrip(b'\r\n')==fixture.rstrip(b'\r\n')
receipt={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'state':'STOP: captured engine exit1 vs contract exit2; no reinterpretation','engine_exit':meta['exit_code'],'inner_python_exit_2_observed_in_stderr':'Some(2)' in err,'raw':{k:{'bytes':len(b),'sha256':sha(b)} for k,b in streams.items()},'report':{'route':report['route'],'format':report['format'],'shots':report['shots'],'blocked':report['blocked'],'warning_count':len(warns),'warning_codes':counts},'AI_stdout_lines':len(ai),'AI_ordinary_fixed_lines':len(normal),'AI_event_lines':len(evlines),'AI_event_string_leaves':len(ai_leaves),'model_path_or_API_markers':len(model_hits),'model_calls':0,'formal_imports':1,'badshot_imports':0,'retry':0,'event_identical_to_frozen_fixture_excluding_only_terminal_CRLF':identical,'event_without_terminal_line_ending_sha256':sha(streams['vacut_events'].rstrip(b'\r\n')),'stderr_original':err,'no_raw_or_gate_edits':True}
(root/'.codex-handoff/root-review-51389530-STOP.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(receipt,ensure_ascii=False,indent=2))