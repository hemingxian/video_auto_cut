import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getGatewayKey, gatewayRemoteEnv } from '../../../electron/aliyun-gateway-key.ts';
import { coerceRemoteEnv, GATEWAY_CREDENTIAL_ENV_KEYS } from '../../../electron/managed-config.ts';

const audit = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(audit, 'state.json'), 'utf8'));
const expectedHead = '2cad82d773f8bbfc9e66013628322dd499a3d161';
const expectedEngine = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf';
const expectedFixture = '33a47aefc3d6e97d7cb556f827cfccbbac9dd2aba8e9cb35ae227b165869cc0a';
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repo, encoding: 'utf8' }).trim() !== expectedHead) throw new Error('source HEAD lock failed');
if (sha256(path.join(state.runtime, 'VideoAutoCutEngine.exe')) !== expectedEngine) throw new Error('engine SHA lock failed');
if (sha256(state.script) !== expectedFixture) throw new Error('fixture SHA lock failed');
for (const key of ['workspace','output','temp']) { const p=path.resolve(state[key]); if (!p.startsWith(path.resolve(audit) + path.sep)) throw new Error(`${key} is not confined to audit root`); }
for (const key of ['pi_agent','appdata']) { const p=path.resolve(state[key]); if (!p.startsWith(path.resolve(state.accepted_isolation_root) + path.sep)) throw new Error(`${key} is not confined to accepted isolation`); }
for (const key of ['workspace','output','temp']) if (fs.existsSync(state[key])) throw new Error(`${key} must not exist before plan-only`);
const attemptMarker = path.join(audit, 'PLAN-ATTEMPT-CONSUMED.json');
if (fs.existsSync(attemptMarker)) throw new Error('plan-only attempt already consumed');
const auth = JSON.parse(fs.readFileSync(path.join(path.dirname(state.env), 'auth.json'), 'utf8'));
const fileEnv: Record<string, string> = {};
for (const line of fs.readFileSync(state.env, 'utf8').split(/\r?\n/)) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const at = line.indexOf('=');
  if (at > 0) fileEnv[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
}
const baseUrl = 'https://api.evstai.com';
const gateway = await getGatewayKey({
  baseUrl, accessToken: auth.accessToken || auth.token,
  requestJson: async (url, options = {}) => {
    const response = await fetch(url, { headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs || 30000) });
    if (!response.ok) throw new Error(`Account configuration HTTP ${response.status}`);
    return await response.json();
  },
});
const account = coerceRemoteEnv({ ...(auth.remoteConfigEnv || {}), ...gatewayRemoteEnv(gateway, baseUrl) });
const managed = { ...coerceRemoteEnv(fileEnv), ...account };
for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) {
  delete managed[key];
  if (account[key]) managed[key] = account[key];
}
const env = {
  ...process.env, ...fileEnv, ...managed,
  SUBTITLE_BOLD: '1', VIDEOAUTO_REQUIRE_REMOTE_CONFIG: 'true',
  VIDEOAUTO_REMOTE_CONFIG_KEYS: Object.keys(managed).join(','),
  VIDEOAUTO_ROOT: state.runtime, VIDEOAUTO_RUNTIME_ROOT: state.runtime,
  VIDEOAUTO_DATA_ROOT: state.workspace, VIDEOAUTO_WORKSPACE_DIR: state.workspace,
  VIDEOAUTO_CONFIG_ROOT: path.dirname(state.env), VIDEOAUTO_ENV_PATH: state.env,
  VIDEOAUTO_OUTPUT_DIR: state.output, VIDEOAUTO_TEMP_DIR: state.temp,
  PI_CODING_AGENT_DIR: state.pi_agent, APPDATA: state.appdata, TEMP: state.temp, TMP: state.temp,
  VIDEOAUTO_NO_PAUSE: 'true', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
};
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = [path.join(state.runtime, 'ffmpeg/bin'), path.join(state.runtime, 'node-runtime'), env[pathKey] || ''].join(path.delimiter);
const args = [
  '--plan-only', '--script-file', state.script,
  '--project-name', state.project_name,
  '--aspect-ratio', '16:9', '--output-resolution', '1080p', '--source', 'pexels',
];
const settings = Object.fromEntries(['MATERIAL_MATCH_MIN_SCORE', 'SENTRY_MATCH_THRESHOLD', 'MATERIAL_AGENT_SELECT',
  'MATERIAL_AGENT_BACKEND', 'MATERIAL_AGENT_DASHSCOPE_THINKING', 'MATERIAL_AGENT_RESERVE_RATIO',
  'MATERIAL_AGENT_FALLBACK', 'MATERIAL_AGENT_MIN_ACCEPT_SCORE', 'DASHSCOPE_VISUAL_REVIEW_MODEL', 'PROGRESS_BAR', 'VIDEOAUTO_ENV_PATH'].map(key => [key, env[key] ?? '(unset)']));
fs.writeFileSync(path.join(audit, 'invocation.json'), JSON.stringify({ executable: path.join(state.runtime, 'VideoAutoCutEngine.exe'), args, settings }, null, 2));
const sensitive = [...Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value), auth.accessToken, auth.token].filter(value => typeof value === 'string' && value.length > 8);
const redact = (text: string) => sensitive.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
const logFile = path.join(audit, 'engine-full.log');
fs.writeFileSync(logFile, `[acceptance] ${new Date().toISOString()} start\n[acceptance] env_file=${state.env}\n`);
const stdoutRawPath = path.join(audit, 'plan-stdout.private.bin');
const stderrRawPath = path.join(audit, 'plan-stderr.private.bin');
const stdoutRaw = fs.openSync(stdoutRawPath, 'wx');
const stderrRaw = fs.openSync(stderrRawPath, 'wx');
const started = Date.now();
let runDir = '';
fs.writeFileSync(attemptMarker, JSON.stringify({ started_at: new Date(started).toISOString(), expected_head: expectedHead }, null, 2) + '\n', { flag: 'wx' });
const child = spawn(path.join(state.runtime, 'VideoAutoCutEngine.exe'), args, { cwd: state.runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(path.join(audit, 'engine-pid.txt'), String(child.pid));
fs.writeFileSync(path.join(audit, 'plan-spawn.json'), JSON.stringify({ executable: path.join(state.runtime, 'VideoAutoCutEngine.exe'), executable_sha256: sha256(path.join(state.runtime, 'VideoAutoCutEngine.exe')), args, started_at: new Date(started).toISOString() }, null, 2) + '\n');
console.log(`ACCEPTANCE_STARTED project=${state.project_name} pid=${child.pid}`);
for (const [stream, rawFd] of [[child.stdout, stdoutRaw], [child.stderr, stderrRaw]] as const) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (line: string) => {
    const clean = redact(line);
    const match = clean.match(/运行目录:\s*(.+)$/);
    if (match) runDir = match[1].trim();
    fs.appendFileSync(logFile, clean + '\n');
    if (/\[agent\]|匹配接受阈值|运行目录:|程序正常结束|ACCEPTANCE|^错误:|Traceback|HTTPError/.test(clean)) console.log(clean);
  };
  stream.on('data', chunk => {
    fs.writeSync(rawFd, chunk);
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
    for (const line of lines) emit(line);
  });
  stream.on('end', () => { pending += decoder.end(); if (pending) emit(pending); });
}
child.on('error', error => console.error(`Engine launch error: ${error.name}`));
child.on('close', (code, signal) => {
  fs.closeSync(stdoutRaw); fs.closeSync(stderrRaw);
  const result = { code, signal, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), elapsed_seconds: (Date.now() - started) / 1000, run_dir: runDir, log: logFile, executable_sha256: sha256(path.join(state.runtime, 'VideoAutoCutEngine.exe')), stdout: { bytes: fs.statSync(stdoutRawPath).size, sha256: sha256(stdoutRawPath) }, stderr: { bytes: fs.statSync(stderrRawPath).size, sha256: sha256(stderrRawPath) } };
  fs.writeFileSync(path.join(audit, 'engine-result.json'), JSON.stringify(result, null, 2));
  console.log('ACCEPTANCE_RESULT ' + JSON.stringify(result));
  process.exitCode = code ?? 1;
});
