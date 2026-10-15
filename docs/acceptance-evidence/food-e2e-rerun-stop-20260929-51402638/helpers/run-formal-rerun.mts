import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getGatewayKey, gatewayRemoteEnv } from '../../../electron/aliyun-gateway-key.ts';
import { coerceRemoteEnv, GATEWAY_CREDENTIAL_ENV_KEYS } from '../../../electron/managed-config.ts';

const audit = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(audit, 'formal-state.json'), 'utf8'));
const expectedHead = '1f86b0b71d18cf617fabc3501fac1784fbff7e4a';
const expectedEngine = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf';
const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repo, encoding: 'utf8' }).trim() !== expectedHead) throw new Error('source HEAD lock failed');
if (sha256(path.join(state.runtime, 'VideoAutoCutEngine.exe')) !== expectedEngine) throw new Error('engine SHA lock failed');
if (sha256(state.plan) !== state.plan_sha256) throw new Error('prepared plan SHA lock failed');
if (sha256(state.manifest) !== state.manifest_sha256) throw new Error('prepared manifest SHA lock failed');
const manifest = JSON.parse(fs.readFileSync(state.manifest, 'utf8'));
if (manifest.run_id !== state.run_id || manifest.task_revision !== 0 || manifest.shots?.length !== 9) throw new Error('manifest run/revision/shot lock failed');
for (const key of ['workspace','output','temp']) { const p=path.resolve(state[key]); if (!p.startsWith(path.resolve(audit) + path.sep)) throw new Error(`${key} is not confined to audit root`); }
for (const key of ['pi_agent','appdata']) { const p=path.resolve(state[key]); if (!p.startsWith(path.resolve(state.accepted_isolation_root) + path.sep)) throw new Error(`${key} is not confined to accepted isolation`); }
for (const key of ['workspace','output','temp']) if (fs.existsSync(state[key]) && fs.readdirSync(state[key]).length !== 0) throw new Error(`${key} must be absent or empty before formal run`);
const marker = path.join(audit, 'FORMAL-ATTEMPT-CONSUMED.json');
if (fs.existsSync(marker)) throw new Error('formal Route-A attempt already consumed');
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
for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) { delete managed[key]; if (account[key]) managed[key] = account[key]; }
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
const executable = path.join(state.runtime, 'VideoAutoCutEngine.exe');
const args = ['--restart-all', '--shots-json', state.plan, '--material-manifest', state.manifest,
  '--project-name', state.project_name, '--aspect-ratio', '16:9', '--output-resolution', '1080p', '--source', 'pexels'];
const startedAt = new Date().toISOString();
fs.mkdirSync(state.temp, { recursive: true });
fs.mkdirSync(path.join(state.workspace, 'temp'), { recursive: true });
const tempReceipt = {
  created_at: startedAt,
  launcher: { TEMP: state.temp, TMP: state.temp, VIDEOAUTO_TEMP_DIR: state.temp },
  created_before_spawn: {
    formal_temp: fs.existsSync(state.temp),
    child_workspace_temp: fs.existsSync(path.join(state.workspace, 'temp')),
  },
  directories_empty: {
    formal_temp: fs.readdirSync(state.temp).length === 0,
    child_workspace_temp: fs.readdirSync(path.join(state.workspace, 'temp')).length === 0,
  },
};
if (!tempReceipt.created_before_spawn.formal_temp || !tempReceipt.created_before_spawn.child_workspace_temp ||
    !tempReceipt.directories_empty.formal_temp || !tempReceipt.directories_empty.child_workspace_temp) throw new Error('isolated temp precreation failed');
fs.writeFileSync(path.join(audit, 'temp-precreate-receipt.json'), JSON.stringify(tempReceipt, null, 2) + '\n');
const sensitive = [...Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value), auth.accessToken, auth.token].filter(value => typeof value === 'string' && value.length > 8) as string[];
const redact = (text: string) => sensitive.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text);
const rawOut = fs.openSync(path.join(audit, 'formal-stdout.private.bin'), 'wx');
const rawErr = fs.openSync(path.join(audit, 'formal-stderr.private.bin'), 'wx');
const derived = path.join(audit, 'formal-derived-redacted.log');
fs.writeFileSync(derived, `[acceptance] ${startedAt} start\n`);
const observer = spawn('C:\\Users\\evstm\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe',
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(audit, 'capture-child-env.ps1'),
   '-PidFile', path.join(audit, 'formal-engine-pid.txt'), '-OutputFile', path.join(audit, 'actual-process-environment.json'),
   '-ReadyFile', path.join(audit, 'observer-ready.json')],
  { cwd: audit, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } });
observer.stderr.on('data', chunk => fs.appendFileSync(path.join(audit, 'observer-error.log'), chunk));
const readyFile = path.join(audit, 'observer-ready.json');
for (let attempt = 0; attempt < 200 && !fs.existsSync(readyFile); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
if (!fs.existsSync(readyFile)) { observer.kill(); throw new Error('process environment observer did not become ready'); }
fs.writeFileSync(marker, JSON.stringify({ started_at: startedAt, executable, executable_sha256: sha256(executable), args }, null, 2) + '\n', { flag: 'wx' });
const child = spawn(executable, args, { cwd: state.runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(path.join(audit, 'formal-engine-pid.txt'), String(child.pid));
let pendingOut = '', pendingErr = '';
let stopRequested = false;
const stdoutDecoder = new StringDecoder('utf8');
const stderrDecoder = new StringDecoder('utf8');
const consume = (kind: 'stdout'|'stderr', chunk: Buffer) => {
  fs.writeSync(kind === 'stdout' ? rawOut : rawErr, chunk);
  const text = (kind === 'stdout' ? pendingOut + stdoutDecoder.write(chunk) : pendingErr + stderrDecoder.write(chunk));
  const lines = text.split(/\r?\n/); const pending = lines.pop() || '';
  if (kind === 'stdout') pendingOut = pending; else pendingErr = pending;
  for (const line of lines) {
    const safeLine = redact(line);
    fs.appendFileSync(derived, `[${kind}] ${safeLine}\n`);
    if (/InternalError|Traceback \(most recent call last\)|\bFATAL\b|错误:|失败:|panicked at/i.test(safeLine)) {
      const errorMarker = path.join(audit, 'REALTIME-ERROR-DETECTED.jsonl');
      fs.appendFileSync(errorMarker, JSON.stringify({ detected_at: new Date().toISOString(), stream: kind, line: safeLine }) + '\n');
      if (!stopRequested) {
        stopRequested = true;
        fs.writeFileSync(path.join(audit, 'OWNED-PROCESS-TREE-STOP.json'), JSON.stringify({ requested_at: new Date().toISOString(), root_pid: child.pid, reason: safeLine, method: 'taskkill /PID <owned-root> /T /F' }, null, 2) + '\n', { flag: 'wx' });
        try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
        catch (error) { fs.appendFileSync(path.join(audit, 'observer-error.log'), `[stop-error] ${error instanceof Error ? error.name : 'unknown'}\n`); }
      }
    }
  }
};
child.stdout.on('data', chunk => consume('stdout', chunk));
child.stderr.on('data', chunk => consume('stderr', chunk));
child.on('error', error => fs.appendFileSync(derived, `[spawn-error] ${error.name}\n`));
child.on('close', (code, signal) => {
  pendingOut += stdoutDecoder.end(); pendingErr += stderrDecoder.end();
  if (pendingOut) fs.appendFileSync(derived, `[stdout] ${redact(pendingOut)}\n`);
  if (pendingErr) fs.appendFileSync(derived, `[stderr] ${redact(pendingErr)}\n`);
  fs.closeSync(rawOut); fs.closeSync(rawErr);
  const result = {
    code, signal, started_at: startedAt, ended_at: new Date().toISOString(),
    executable, executable_sha256: sha256(executable), args,
    stdout: { bytes: fs.statSync(path.join(audit, 'formal-stdout.private.bin')).size, sha256: sha256(path.join(audit, 'formal-stdout.private.bin')) },
    stderr: { bytes: fs.statSync(path.join(audit, 'formal-stderr.private.bin')).size, sha256: sha256(path.join(audit, 'formal-stderr.private.bin')) },
    derived_redacted_sha256: sha256(derived), no_retry: true,
    input_plan_sha256: sha256(state.plan), input_manifest_sha256: sha256(state.manifest), run_id: state.run_id,
  };
  fs.writeFileSync(path.join(audit, 'formal-result.json'), JSON.stringify(result, null, 2) + '\n');
  process.exitCode = code ?? 1;
});
