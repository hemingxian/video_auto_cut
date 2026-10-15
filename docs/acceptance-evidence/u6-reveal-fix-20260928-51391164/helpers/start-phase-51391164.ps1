param()

$ErrorActionPreference = 'Stop'

function Get-Sha([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-TcpListener([int]$Port) {
  return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port }).Count -gt 0
}

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Desktop = Join-Path $Repo 'VideoAutoCutDesktop'
$Audit = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928')
$Phase = Join-Path $Audit 'phase-51391164-5893f7d'
$Candidate = [IO.Path]::GetFullPath('D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut')
$ExpectedHead = '5893f7dc76bc87faa7c7907327807fb8893acb3d'
$ExpectedVersion = '3715aa42c0b71894dd62e0df28900b380aa5a43a'
$ExpectedEngineSha = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
$ExpectedMainBuildSha = '815d197af161b2e3051c67d0865645e29a35e80f45238260cb13a1bf15bbaad2'
$ExpectedPreloadBuildSha = 'c61441a295d607b838767b45ff40aff3093df5e8658b7632677c345ead8ec836'
$ExpectedIpcBuildSha = 'a4e27d3f0974e9da97e6ffb787023167bae7e582c66eece92322315ac58ad0ef'
$ExpectedRevealBuildSha = '3e656a28571af9af52ca3873e49485ccec8b77ad4d4b81a618f3b3f86ee9eb15'
$ManifestIsolationUrl = 'http://127.0.0.1:9/runtime/manifest.json'
$CurrentPath = Join-Path $Audit 'data\runtime\current.json'
$PrepReceiptPath = Join-Path $Phase 'receipts\phase-preparation.json'
$TapPath = Join-Path $Phase 'scripts\electron-stdout-tap.cjs'

$head = (& git -C $Repo rev-parse HEAD).Trim()
if ($head -ne $ExpectedHead) { throw "Unexpected HEAD: $head" }
$status = @(& git -C $Repo status --short)
$expectedStatus = @(' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json')
if (($status -join "`n") -ne ($expectedStatus -join "`n")) { throw "Unexpected git status: $($status -join '; ')" }
if (Test-TcpListener 9) { throw 'Manifest-isolation loopback port 9 has a listener' }
if (Test-TcpListener 4173) { throw 'Port 4173 already has a listener' }
if (-not (Test-Path -LiteralPath $PrepReceiptPath -PathType Leaf)) { throw 'Missing preparation receipt' }
$prepReceipt = Get-Content -LiteralPath $PrepReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
$current = Get-Content -LiteralPath $CurrentPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$current.version -ne $ExpectedVersion) { throw "Unexpected current version: $($current.version)" }
if ([IO.Path]::GetFullPath([string]$current.path) -ne $Candidate) { throw "Unexpected current runtime path: $($current.path)" }
if ((Get-Sha $CurrentPath) -ne [string]$prepReceipt.current.sha256) { throw 'current.json changed after preparation' }
if ((Get-Sha (Join-Path $Candidate 'VideoAutoCutEngine.exe')) -ne $ExpectedEngineSha) { throw 'Candidate engine SHA changed' }
if ((Get-Sha $TapPath) -ne '4c528f71fd1dbb8b181f8a9f91866018a2b654e02d24a93aa3cda8b6a409a4dc') { throw 'Observer module SHA changed' }
if ((Get-Sha (Join-Path $Desktop 'dist-electron\main.js')) -ne $ExpectedMainBuildSha) { throw 'Fixed Electron main build changed' }
if ((Get-Sha (Join-Path $Desktop 'dist-electron\preload.cjs')) -ne $ExpectedPreloadBuildSha) { throw 'Fixed Electron preload build changed' }
if ((Get-Sha (Join-Path $Desktop 'dist-electron\ipc-handlers.js')) -ne $ExpectedIpcBuildSha) { throw 'Fixed IPC build changed' }
if ((Get-Sha (Join-Path $Desktop 'dist-electron\script-reveal.js')) -ne $ExpectedRevealBuildSha) { throw 'Fixed reveal build changed' }

$env:VIDEOAUTO_USER_DATA_ROOT = Join-Path $Audit 'user-data'
$env:VIDEOAUTO_CONFIG_ROOT = Join-Path $Audit 'config'
$env:VIDEOAUTO_DATA_ROOT = Join-Path $Audit 'data'
$env:VIDEOAUTO_WORKSPACE_DIR = Join-Path $Audit 'data'
$env:VIDEOAUTO_ROOT = $Candidate
$env:VIDEOAUTO_RUNTIME_ROOT = $Candidate
$env:VIDEOAUTO_ENV_PATH = Join-Path $Audit 'config\app.env'
$env:PI_CODING_AGENT_DIR = Join-Path $Audit 'pi-agent'
$env:VIDEOAUTO_TEMP_DIR = Join-Path $Audit 'temp'
$env:VIDEOAUTO_OUTPUT_DIR = Join-Path $Audit 'output'
$env:APPDATA = Join-Path $Audit 'appdata'
$env:TEMP = Join-Path $Audit 'temp'
$env:TMP = Join-Path $Audit 'temp'
$env:VIDEOAUTO_RUNTIME_MANIFEST_URL = $ManifestIsolationUrl
$env:VIDEOAUTOCUT_RUNTIME_MANIFEST_URL = $ManifestIsolationUrl
$env:VACUT_STDOUT_CAPTURE_ROOT = Join-Path $Phase 'raw-electron-stdout'
$env:VACUT_CAPTURE_OWNER_BASENAME = 'electron.exe'
$env:VACUT_CAPTURE_COMMAND_BASENAME = 'VideoAutoCutEngine.exe'
$env:VACUT_CAPTURE_PREFLIGHT_ENGINE_PATH = Join-Path $Candidate 'VideoAutoCutEngine.exe'
$env:NODE_OPTIONS = "--require=$TapPath"

$LaunchReceipt = [ordered]@{
  schema = 'vacut-u6-phase-51391164-5893f7d-launch/v1'
  written_at = (Get-Date).ToUniversalTime().ToString('o')
  launcher_pid = $PID
  source_head = $head
  audit_root = $Audit
  phase_root = $Phase
  reused_prior_user_data = $true
  candidate_path = $Candidate
  candidate_engine_sha256 = $ExpectedEngineSha
  current_json_sha256 = Get-Sha $CurrentPath
  manifest_isolation = [ordered]@{
    method = 'process environment manifest URL isolation; not a product disable flag'
    url = $ManifestIsolationUrl
    aliases_set = @('VIDEOAUTO_RUNTIME_MANIFEST_URL','VIDEOAUTOCUT_RUNTIME_MANIFEST_URL')
    loopback_listener_present = $false
  }
  app_started_when_written = $false
  import_invocations = 0
  model_invocations = 0
  secret_values_recorded = $false
}
$LaunchReceiptPath = Join-Path $Phase 'receipts\launch-environment.json'
[IO.File]::WriteAllText($LaunchReceiptPath, (($LaunchReceipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $Phase 'launcher.pid'), [string]$PID, [Text.UTF8Encoding]::new($false))

Push-Location $Desktop
try {
  & (Join-Path $Desktop 'node_modules\.bin\concurrently.cmd') -k `
    'node_modules\.bin\vite.cmd --host 127.0.0.1 --port 4173' `
    'node_modules\.bin\wait-on.cmd http://127.0.0.1:4173 && node_modules\.bin\cross-env.cmd VITE_DEV_SERVER_URL=http://127.0.0.1:4173 node_modules\.bin\electron.cmd .'
} finally {
  Pop-Location
}
