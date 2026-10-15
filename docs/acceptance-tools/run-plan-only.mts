import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getGatewayKey, gatewayRemoteEnv } from '../../../electron/aliyun-gateway-key.ts';
import { coerceRemoteEnv, GATEWAY_CREDENTIAL_ENV_KEYS } from '../../../electron/managed-config.ts';

const audit = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(audit, 'state.json'), 'utf8'));
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
const workspace = path.resolve(state.runtime, '../../..');
const env = {
  ...process.env, ...fileEnv, ...managed,
  SUBTITLE_BOLD: '1', VIDEOAUTO_REQUIRE_REMOTE_CONFIG: 'true',
  VIDEOAUTO_REMOTE_CONFIG_KEYS: Object.keys(managed).join(','),
  VIDEOAUTO_ROOT: state.runtime, VIDEOAUTO_RUNTIME_ROOT: state.runtime,
  VIDEOAUTO_DATA_ROOT: workspace, VIDEOAUTO_WORKSPACE_DIR: workspace,
  VIDEOAUTO_CONFIG_ROOT: path.dirname(state.env), VIDEOAUTO_ENV_PATH: state.env,
  VIDEOAUTO_OUTPUT_DIR: fileEnv.VIDEOAUTO_OUTPUT_DIR || path.join(workspace, 'video/output'),
  VIDEOAUTO_TEMP_DIR: fileEnv.VIDEOAUTO_TEMP_DIR || path.join(workspace, 'temp'),
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
const started = Date.now();
let runDir = '';
const child = spawn(path.join(state.runtime, 'VideoAutoCutEngine.exe'), args, { cwd: state.runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(path.join(audit, 'engine-pid.txt'), String(child.pid));
console.log(`ACCEPTANCE_STARTED project=${state.project_name} pid=${child.pid}`);
for (const stream of [child.stdout, child.stderr]) {
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
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
    for (const line of lines) emit(line);
  });
  stream.on('end', () => { pending += decoder.end(); if (pending) emit(pending); });
}
child.on('error', error => console.error(`Engine launch error: ${error.name}`));
child.on('close', (code, signal) => {
  const result = { code, signal, started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), elapsed_seconds: (Date.now() - started) / 1000, run_dir: runDir, log: logFile };
  fs.writeFileSync(path.join(audit, 'engine-result.json'), JSON.stringify(result, null, 2));
  console.log('ACCEPTANCE_RESULT ' + JSON.stringify(result));
  process.exitCode = code ?? 1;
});
