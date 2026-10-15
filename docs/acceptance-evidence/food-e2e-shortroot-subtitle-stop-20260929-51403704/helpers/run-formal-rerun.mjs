import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
//#region electron/aliyun-gateway-key.ts
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function clean(value) {
	return value === void 0 || value === null ? "" : String(value).trim();
}
function positiveInteger(value) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
function responseData(value) {
	const record = asRecord$1(value);
	return Object.prototype.hasOwnProperty.call(record, "data") ? record.data : value;
}
function responseItems(value) {
	const data = responseData(value);
	if (Array.isArray(data)) return data;
	const record = asRecord$1(data);
	if (Array.isArray(record.items)) return record.items;
	if (Array.isArray(record.list)) return record.list;
	return [];
}
function normalizeKey(value) {
	const record = asRecord$1(value);
	const group = asRecord$1(record.group);
	const id = positiveInteger(record.id);
	const groupId = positiveInteger(record.group_id ?? record.groupId ?? group.id);
	const key = clean(record.key);
	if (!id || !key) return null;
	return {
		id,
		key,
		name: clean(record.name),
		groupId,
		status: clean(record.status).toLowerCase(),
		expiresAt: clean(record.expires_at ?? record.expiresAt)
	};
}
function isUnexpired(expiresAt, nowMs) {
	if (!expiresAt) return true;
	const timestamp = Date.parse(expiresAt);
	return Number.isFinite(timestamp) && timestamp > nowMs;
}
function selectActiveGatewayKey(response, nowMs = Date.now()) {
	return responseItems(response).map(normalizeKey).find((key) => Boolean(key && key.status === "active" && isUnexpired(key.expiresAt, nowMs))) || null;
}
function forceGatewayBaseEnv(current, baseUrl) {
	const root = baseUrl.trim().replace(/\/+$/, "");
	return root ? {
		...current,
		DASHSCOPE_BASE_URL: root
	} : { ...current };
}
function gatewayRemoteEnv(result, baseUrl) {
	return forceGatewayBaseEnv({ DASHSCOPE_API_KEY: result.apiKey }, baseUrl);
}
async function getGatewayKey({ baseUrl, accessToken, requestJson }) {
	const root = baseUrl.trim().replace(/\/+$/, "");
	const token = accessToken.trim();
	if (!root) throw new Error("GATEWAY_BASE_URL_MISSING");
	if (!token) throw new Error("SUB2API_TOKEN_MISSING");
	const headers = { Authorization: `Bearer ${token}` };
	const existing = selectActiveGatewayKey(await requestJson(`${root}/api/v1/keys?status=active&page=1&page_size=1000`, {
		headers,
		timeoutMs: 15e3
	}));
	if (!existing) throw new Error("GATEWAY_KEY_UNAVAILABLE");
	return {
		apiKey: existing.key,
		keyId: existing.id,
		groupId: existing.groupId
	};
}
//#endregion
//#region electron/types.ts
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function asRecord(value) {
	return isRecord(value) ? value : {};
}
//#endregion
//#region electron/utils.ts
function cleanConfiguredPath(value) {
	return String(value || "").trim().replace(/^["']|["']$/g, "");
}
//#endregion
//#region electron/managed-env-keys.ts
const REMOTE_MANAGED_ENV_KEYS = [
	"VIDEOAUTO_MATERIAL_API_BASE_URL",
	"DASHSCOPE_API_KEY",
	"PEXELS_API_KEY",
	"PIXABAY_API_KEY",
	"JAMENDO_CLIENT_ID",
	"OPENVERSE_CLIENT_ID",
	"OPENVERSE_CLIENT_SECRET",
	"DASHSCOPE_BASE_URL",
	"DASHSCOPE_OPENAI_BASE_URL",
	"DASHSCOPE_OPENAI_FILES_URL",
	"DASHSCOPE_FILE_UPLOAD_URL",
	"DASHSCOPE_HTTP_BASE_URL",
	"DASHSCOPE_UPLOADS_URL",
	"DASHSCOPE_TEXT_MODEL",
	"DASHSCOPE_SCRIPT_MODEL",
	"DASHSCOPE_SCRIPT_REVIEW_MODEL",
	"DASHSCOPE_SCRIPT_TIMEOUT",
	"DASHSCOPE_DOWNLOAD_REVIEW_MODEL",
	"DASHSCOPE_EMBEDDING_MODEL",
	"DASHSCOPE_TTS_MODEL",
	"DASHSCOPE_TTS_URL",
	"DASHSCOPE_TTS_FORMAT",
	"DASHSCOPE_TTS_SAMPLE_RATE",
	"DASHSCOPE_ASR_MODEL",
	"DASHSCOPE_ASR_UPLOAD_MODEL",
	"DASHSCOPE_ASR_TRANSCRIPTION_URL",
	"DASHSCOPE_ASR_TASK_BASE_URL",
	"DASHSCOPE_VOICE_UPLOAD_MODEL",
	"DASHSCOPE_VOICE_CUSTOMIZATION_URL"
];
const REMOTE_SECRET_ENV_KEYS = [
	"DASHSCOPE_API_KEY",
	"PEXELS_API_KEY",
	"PIXABAY_API_KEY",
	"JAMENDO_CLIENT_ID",
	"OPENVERSE_CLIENT_ID",
	"OPENVERSE_CLIENT_SECRET"
];
//#endregion
//#region electron/managed-config.ts
const REMOTE_MANAGED_ENV_KEY_SET = new Set(REMOTE_MANAGED_ENV_KEYS);
new Set(REMOTE_SECRET_ENV_KEYS);
const GATEWAY_CREDENTIAL_ENV_KEYS = ["DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL"];
const REMOTE_CONFIG_ALIASES = {
	ALIYUN_DASHSCOPE_API_KEY: "DASHSCOPE_API_KEY",
	DASHSCOPE: "DASHSCOPE_API_KEY",
	DASHSCOPE_KEY: "DASHSCOPE_API_KEY",
	QWEN_API_KEY: "DASHSCOPE_API_KEY",
	PEXELS: "PEXELS_API_KEY",
	PEXELS_KEY: "PEXELS_API_KEY",
	PIXABAY: "PIXABAY_API_KEY",
	PIXABAY_KEY: "PIXABAY_API_KEY",
	JAMENDO: "JAMENDO_CLIENT_ID",
	JAMENDO_KEY: "JAMENDO_CLIENT_ID",
	JAMENDO_CLIENT: "JAMENDO_CLIENT_ID",
	OPENVERSE_CLIENT: "OPENVERSE_CLIENT_ID",
	OPENVERSE_ID: "OPENVERSE_CLIENT_ID",
	OPENVERSE_SECRET: "OPENVERSE_CLIENT_SECRET",
	OPENVERSE_KEY: "OPENVERSE_CLIENT_SECRET"
};
function normalizeRemoteConfigKey(key) {
	const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
	return REMOTE_CONFIG_ALIASES[normalized] || normalized;
}
function isManagedEnvKey(key) {
	return REMOTE_MANAGED_ENV_KEY_SET.has(key);
}
function cleanRemoteConfigValue(value) {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return cleanConfiguredPath(value);
}
function coerceRemoteEnv(value) {
	const record = asRecord(value);
	const env = {};
	for (const [rawKey, rawValue] of Object.entries(record)) {
		const key = normalizeRemoteConfigKey(rawKey);
		if (!isManagedEnvKey(key)) continue;
		const cleanValue = cleanRemoteConfigValue(rawValue);
		if (cleanValue) env[key] = cleanValue;
	}
	return env;
}
//#endregion
//#region node_modules/.tmp/food-route-a-51400401-2cad82d-20260929/run-formal-route-a.mts
const audit = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(audit, "formal-state.json"), "utf8"));
const expectedHead = "665cdc0c89e43dbe0b218d7dcb5ebcf91c599017";
const expectedEngine = "be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf";
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
if (execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: state.repo,
	encoding: "utf8"
}).trim() !== expectedHead) throw new Error("source HEAD lock failed");
if (sha256(path.join(state.runtime, "VideoAutoCutEngine.exe")) !== expectedEngine) throw new Error("engine SHA lock failed");
if (sha256(state.plan) !== state.plan_sha256) throw new Error("prepared plan SHA lock failed");
if (sha256(state.manifest) !== state.manifest_sha256) throw new Error("prepared manifest SHA lock failed");
const manifest = JSON.parse(fs.readFileSync(state.manifest, "utf8"));
if (manifest.run_id !== state.run_id || manifest.task_revision !== 0 || manifest.shots?.length !== 9) throw new Error("manifest run/revision/shot lock failed");
for (const key of [
	"workspace",
	"output",
	"temp"
]) if (!path.resolve(state[key]).startsWith(path.resolve(audit) + path.sep)) throw new Error(`${key} is not confined to audit root`);
for (const key of ["pi_agent", "appdata"]) if (!path.resolve(state[key]).startsWith(path.resolve(audit) + path.sep)) throw new Error(`${key} is not confined to short audit root`);
for (const key of [
	"workspace",
	"output",
	"temp"
]) if (fs.existsSync(state[key]) && fs.readdirSync(state[key]).length !== 0) throw new Error(`${key} must be absent or empty before formal run`);
const marker = path.join(audit, "FORMAL-ATTEMPT-CONSUMED.json");
if (fs.existsSync(marker)) throw new Error("formal Route-A attempt already consumed");
const auth = JSON.parse(fs.readFileSync(path.join(path.dirname(state.env), "auth.json"), "utf8"));
const fileEnv = {};
for (const line of fs.readFileSync(state.env, "utf8").split(/\r?\n/)) {
	if (!line.trim() || line.trimStart().startsWith("#")) continue;
	const at = line.indexOf("=");
	if (at > 0) fileEnv[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
}
const baseUrl = "https://api.evstai.com";
const gateway = await getGatewayKey({
	baseUrl,
	accessToken: auth.accessToken || auth.token,
	requestJson: async (url, options = {}) => {
		const response = await fetch(url, {
			headers: options.headers,
			signal: AbortSignal.timeout(options.timeoutMs || 3e4)
		});
		if (!response.ok) throw new Error(`Account configuration HTTP ${response.status}`);
		return await response.json();
	}
});
const account = coerceRemoteEnv({
	...auth.remoteConfigEnv || {},
	...gatewayRemoteEnv(gateway, baseUrl)
});
const managed = {
	...coerceRemoteEnv(fileEnv),
	...account
};
for (const key of GATEWAY_CREDENTIAL_ENV_KEYS) {
	delete managed[key];
	if (account[key]) managed[key] = account[key];
}
const env = {
	...process.env,
	...fileEnv,
	...managed,
	SUBTITLE_BOLD: "1",
	VIDEOAUTO_REQUIRE_REMOTE_CONFIG: "true",
	VIDEOAUTO_REMOTE_CONFIG_KEYS: Object.keys(managed).join(","),
	VIDEOAUTO_ROOT: state.runtime,
	VIDEOAUTO_RUNTIME_ROOT: state.runtime,
	VIDEOAUTO_DATA_ROOT: state.workspace,
	VIDEOAUTO_WORKSPACE_DIR: state.workspace,
	VIDEOAUTO_CONFIG_ROOT: path.dirname(state.env),
	VIDEOAUTO_ENV_PATH: state.env,
	VIDEOAUTO_OUTPUT_DIR: state.output,
	VIDEOAUTO_TEMP_DIR: state.temp,
	PI_CODING_AGENT_DIR: state.pi_agent,
	APPDATA: state.appdata,
	TEMP: state.temp,
	TMP: state.temp,
	VIDEOAUTO_NO_PAUSE: "true",
	PYTHONUTF8: "1",
	PYTHONIOENCODING: "utf-8"
};
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
env[pathKey] = [
	path.join(state.runtime, "ffmpeg/bin"),
	path.join(state.runtime, "node-runtime"),
	env[pathKey] || ""
].join(path.delimiter);
const executable = path.join(state.runtime, "VideoAutoCutEngine.exe");
const args = [
	"--restart-all",
	"--shots-json",
	state.plan,
	"--material-manifest",
	state.manifest,
	"--project-name",
	state.project_name,
	"--aspect-ratio",
	"16:9",
	"--output-resolution",
	"1080p",
	"--source",
	"pexels"
];
const startedAt = (/* @__PURE__ */ new Date()).toISOString();
const shortRoot = path.resolve(audit);
const estimatedPackagingCwd = path.join(state.workspace, "video", "runs", startedAt.slice(0, 10).replaceAll("-", ""), state.project_name, ".videoautocut", "runs", state.run_id, "final_clips", "packaging", "0009_final");
const estimatedExtendedPackagingCwd = `\\\\?\\${estimatedPackagingCwd}`;
const pathEstimateReceipt = {
	created_at: startedAt,
	short_root: shortRoot,
	short_root_length: shortRoot.length,
	structure: "final_clips\\\\packaging\\\\0009_final",
	estimated_cwd_without_prefix: estimatedPackagingCwd,
	estimated_cwd_without_prefix_length: estimatedPackagingCwd.length,
	estimated_cwd_passed_to_subprocess: estimatedExtendedPackagingCwd,
	estimated_cwd_passed_to_subprocess_length: estimatedExtendedPackagingCwd.length,
	limits: { short_root_max: 20, packaging_cwd_max: 200 },
	pass: shortRoot.length <= 20 && estimatedPackagingCwd.length <= 200 && estimatedExtendedPackagingCwd.length <= 200
};
fs.writeFileSync(path.join(audit, "pre-spawn-path-estimate.json"), JSON.stringify(pathEstimateReceipt, null, 2) + "\n", { flag: "wx" });
if (!pathEstimateReceipt.pass) throw new Error("pre-spawn path estimate exceeds authorized limit");
fs.mkdirSync(state.temp, { recursive: true });
fs.mkdirSync(path.join(state.workspace, "temp"), { recursive: true });
fs.mkdirSync(state.pi_agent, { recursive: true });
fs.mkdirSync(state.appdata, { recursive: true });
const tempReceipt = { created_at: startedAt, launcher: { TEMP: state.temp, TMP: state.temp, VIDEOAUTO_TEMP_DIR: state.temp }, created_before_spawn: { formal_temp: fs.existsSync(state.temp), child_workspace_temp: fs.existsSync(path.join(state.workspace, "temp")) }, directories_empty: { formal_temp: fs.readdirSync(state.temp).length === 0, child_workspace_temp: fs.readdirSync(path.join(state.workspace, "temp")).length === 0 } };
if (!tempReceipt.created_before_spawn.formal_temp || !tempReceipt.created_before_spawn.child_workspace_temp || !tempReceipt.directories_empty.formal_temp || !tempReceipt.directories_empty.child_workspace_temp) throw new Error("isolated temp precreation failed");
fs.writeFileSync(path.join(audit, "temp-precreate-receipt.json"), JSON.stringify(tempReceipt, null, 2) + "\n");
const sensitive = [
	...Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value),
	auth.accessToken,
	auth.token
].filter((value) => typeof value === "string" && value.length > 8);
const redact = (text) => sensitive.reduce((out, secret) => out.split(secret).join("[REDACTED]"), text);
const rawOut = fs.openSync(path.join(audit, "formal-stdout.private.bin"), "wx");
const rawErr = fs.openSync(path.join(audit, "formal-stderr.private.bin"), "wx");
const derived = path.join(audit, "formal-derived-redacted.log");
fs.writeFileSync(derived, `[acceptance] ${startedAt} start\n`);
const observer = spawn("C:\\Users\\evstm\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(audit, "capture-child-env.ps1"), "-PidFile", path.join(audit, "formal-engine-pid.txt"), "-OutputFile", path.join(audit, "actual-process-environment.json"), "-ReadyFile", path.join(audit, "observer-ready.json")], { cwd: audit, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { SystemRoot: process.env.SystemRoot || "C:\\Windows" } });
observer.stderr.on("data", (chunk) => fs.appendFileSync(path.join(audit, "observer-error.log"), chunk));
const readyFile = path.join(audit, "observer-ready.json");
for (let attempt = 0; attempt < 200 && !fs.existsSync(readyFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
if (!fs.existsSync(readyFile)) { observer.kill(); throw new Error("process environment observer did not become ready"); }
fs.writeFileSync(marker, JSON.stringify({ started_at: startedAt, executable, executable_sha256: sha256(executable), args }, null, 2) + "\n", { flag: "wx" });
const child = spawn(executable, args, {
	cwd: state.runtime,
	env,
	windowsHide: true,
	stdio: [
		"ignore",
		"pipe",
		"pipe"
	]
});
fs.writeFileSync(path.join(audit, "formal-engine-pid.txt"), String(child.pid));
let pendingOut = "", pendingErr = "";
let stopRequested = false;
const stdoutDecoder = new StringDecoder("utf8");
const stderrDecoder = new StringDecoder("utf8");
const consume = (kind, chunk) => {
	fs.writeSync(kind === "stdout" ? rawOut : rawErr, chunk);
	const lines = (kind === "stdout" ? pendingOut + stdoutDecoder.write(chunk) : pendingErr + stderrDecoder.write(chunk)).split(/\r?\n/);
	const pending = lines.pop() || "";
	if (kind === "stdout") pendingOut = pending;
	else pendingErr = pending;
	for (const line of lines) {
		const safeLine = redact(line); fs.appendFileSync(derived, `[${kind}] ${safeLine}\n`);
		if (/InternalError|Traceback \(most recent call last\)|\bFATAL\b|错误:|失败:|panicked at/i.test(safeLine)) {
			fs.appendFileSync(path.join(audit, "REALTIME-ERROR-DETECTED.jsonl"), JSON.stringify({ detected_at: (/* @__PURE__ */ new Date()).toISOString(), stream: kind, line: safeLine }) + "\n");
			if (!stopRequested) { stopRequested = true; fs.writeFileSync(path.join(audit, "OWNED-PROCESS-TREE-STOP.json"), JSON.stringify({ requested_at: (/* @__PURE__ */ new Date()).toISOString(), root_pid: child.pid, reason: safeLine, method: "taskkill /PID <owned-root> /T /F" }, null, 2) + "\n", { flag: "wx" }); try { execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch (error) { fs.appendFileSync(path.join(audit, "observer-error.log"), `[stop-error] ${error instanceof Error ? error.name : "unknown"}\n`); } }
		}
	}
};
child.stdout.on("data", (chunk) => consume("stdout", chunk));
child.stderr.on("data", (chunk) => consume("stderr", chunk));
child.on("error", (error) => fs.appendFileSync(derived, `[spawn-error] ${error.name}\n`));
child.on("close", (code, signal) => {
	pendingOut += stdoutDecoder.end();
	pendingErr += stderrDecoder.end();
	if (pendingOut) fs.appendFileSync(derived, `[stdout] ${redact(pendingOut)}\n`);
	if (pendingErr) fs.appendFileSync(derived, `[stderr] ${redact(pendingErr)}\n`);
	fs.closeSync(rawOut);
	fs.closeSync(rawErr);
	const result = {
		code,
		signal,
		started_at: startedAt,
		ended_at: (/* @__PURE__ */ new Date()).toISOString(),
		executable,
		executable_sha256: sha256(executable),
		args,
		stdout: {
			bytes: fs.statSync(path.join(audit, "formal-stdout.private.bin")).size,
			sha256: sha256(path.join(audit, "formal-stdout.private.bin"))
		},
		stderr: {
			bytes: fs.statSync(path.join(audit, "formal-stderr.private.bin")).size,
			sha256: sha256(path.join(audit, "formal-stderr.private.bin"))
		},
		derived_redacted_sha256: sha256(derived),
		no_retry: true,
		input_plan_sha256: sha256(state.plan),
		input_manifest_sha256: sha256(state.manifest),
		run_id: state.run_id
	};
	fs.writeFileSync(path.join(audit, "formal-result.json"), JSON.stringify(result, null, 2) + "\n");
	process.exitCode = code ?? 1;
});
//#endregion
export {};
