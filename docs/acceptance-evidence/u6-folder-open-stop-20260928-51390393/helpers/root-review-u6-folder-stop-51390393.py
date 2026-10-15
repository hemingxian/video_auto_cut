from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(r'D:\autocut\video-auto-cut')
PHASE = ROOT / 'VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928/phase-51390393'
EXPECTED_HEAD = '4d62e25965cbae0bd25f53ff2c45881082c87db6'

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def readj(p):
    return json.loads(Path(p).read_text(encoding='utf-8'))

def exact_lines(data):
    text = data.decode('utf-8', errors='strict')
    return [m.group(0) for m in re.finditer(r'[^\r\n]*(?:\r\n|\n|\r|$)', text) if m.group(0)]

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).rstrip('\r\n')

def main():
    assert git('rev-parse', 'HEAD') == EXPECTED_HEAD
    assert git('branch', '--show-current') == 'feature/material-agent-select'
    assert git('status', '--short').splitlines() == [' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json']
    raw = PHASE / 'raw-electron-stdout'
    metas = sorted(raw.glob('observer-*-metadata.json'))
    assert len(metas) == 2
    meta = readj(raw / 'observer-5836-seq-2-child-13448-metadata.json')
    assert meta['exit_code'] == 1
    outputs = {}
    for key in ('stdout', 'stderr', 'vacut_events'):
        p = raw / meta[key]['path']
        data = p.read_bytes()
        assert sha(p) == meta[key]['sha256']
        assert len(data) == meta[key]['bytes']
        outputs[key] = data
    assert len(outputs['stdout']) == 19876
    assert sha(raw / meta['stdout']['path']) == '296d6c5806db179ebe9d5fd94c82db358c56d0bcc71a6c2b6c553917a3a54c22'
    err_lines = [x.rstrip('\r\n') for x in exact_lines(outputs['stderr']) if x.rstrip('\r\n')]
    assert len(err_lines) == 1
    assert 'AI 解析脚本文档失败' in err_lines[0]
    assert 'python normalize_script, 退出码: Some(2)' in err_lines[0]
    event_lines = exact_lines(outputs['vacut_events'])
    assert len(event_lines) == 1
    payload = json.loads(event_lines[0].removeprefix('VACUT_EVENT:'))
    report = payload['scriptImport']
    assert (report['route'], report['format'], report['shots']) == ('template', 'VAC-SB-1', 8)
    assert len(report['blocked']) == 2
    assert {(b['cell'], b['shot'], b['column'], b['code']) for b in report['blocked']} == {('I9', 8, '口播', 'text_cell_pending'), ('K9', 8, '上屏文字', 'text_cell_pending')}
    warnings = collections.Counter(w['code'] for w in report['warnings'])
    assert warnings == {'ai_suggested': 43, 'status_pending': 8, 'status_note': 2}
    stdout_lines = [x.rstrip('\r\n') for x in exact_lines(outputs['stdout'])]
    ai_lines = [x for x in stdout_lines if 'AI' in x]
    static = [x for x in ai_lines if not x.startswith('VACUT_EVENT:')]
    assert len(ai_lines) == 44 and len(static) == 43
    assert all(re.fullmatch(r'\[script\] 标准模板导入 ai_suggested: [A-Z]+[0-9]+ 制作字段为 AI 建议', x) for x in static)
    assert collections.Counter(re.search(r': ([A-Z]+[0-9]+) ', x)[1] for x in static) == collections.Counter(w['cell'] for w in report['warnings'] if w['code'] == 'ai_suggested')
    assert not re.search(r'Qwen|DashScope|百炼|AI\s*上传脚本文件|AI\s*解析脚本文件', outputs['stdout'].decode('utf-8'), re.I)
    assert outputs['vacut_events'].rstrip(b'\r\n') == (ROOT / 'VideoAutoCutDesktop/tests/fixtures/u6-template-import-event.txt').read_bytes().rstrip(b'\r\n')
    current = PHASE / 'receipts/current-before-formal-u6.json'
    assert current.read_bytes() == (PHASE / 'receipts/current-post-stop.json').read_bytes()
    assert sha(current) == '4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21'
    selected = readj(current)
    engine = Path(selected['path']) / 'VideoAutoCutEngine.exe'
    assert sha(engine) == 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
    stop = readj(PHASE / 'receipts/STOP-folder-open.json')
    assert stop['counts'] == {'help_preflight':1,'formal_import':1,'badshot_import':0,'u7_import':0,'qwen':0,'other_model':0,'generate':0,'folder_button_click':1}
    assert stop['folder_failure']['explorer_opened'] is False
    inventory = readj(PHASE / 'receipts/window-inventory-after-folder-click.json')
    assert inventory['expected_folder_present'] is False
    assert len([w for w in inventory['windows'] if w['app'] == r'process:C:\Windows\explorer.exe']) == 2
    shut = stop['shutdown']
    assert not shut['force_kill_used'] and not shut['launcher_alive_after_wait'] and not shut['electron_owner_alive_after_wait']
    assert shut['port4173_listeners'] == 0 and shut['port9_listeners'] == 0
    for item in stop['protected']:
        assert sha(item['path']) == item['expected_sha256'] == item['actual_sha256']
    log = (PHASE / 'logs/launcher.stdout.log').read_bytes()
    assert sha(PHASE / 'logs/launcher.stdout.log') == stop['logs']['launcher_stdout']['sha256']
    log_lines = exact_lines(log)
    positions = []
    offset = 0
    for i, line in enumerate(log_lines, 1):
        if 'folder:open' in line or 'open folder failed' in line:
            positions.append({'line_crlf_lf_cr':i, 'byte_offset':offset, 'text':line.rstrip('\r\n')})
        offset += len(line.encode('utf-8'))
    assert len(positions) == 2
    assert '目录不在工作区内，已拒绝删除' in positions[0]['text']
    assert r'D:\\autocut\\video-auto-cut\\docs\\script-template-v1' in positions[1]['text']
    assert not re.search(r'(?i)(Bearer\s+[a-z0-9._-]+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])', log.decode('utf-8'))
    result = {'audit':'independent read-only byte audit; no importer/product invocation', 'source_head':EXPECTED_HEAD, 'formal_import_core_pass':True, 'u6_overall':'STOP_FOLDER_OPEN_DENIED', 'warnings':dict(warnings), 'ai_lines':len(ai_lines), 'models':0, 'folder_error_positions':positions, 'current_sha256':sha(current), 'engine_sha256':sha(engine), 'protected_pass':6, 'shutdown_receipt_sha256':sha(PHASE / 'receipts/shutdown.json'), 'stop_receipt_sha256':sha(PHASE / 'receipts/STOP-folder-open.json')}
    path = ROOT / '.codex-handoff/root-review-u6-folder-stop-51390393.json'
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
