param()

$ErrorActionPreference = 'Stop'
function Get-Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Test-TcpListener([int]$Port) { return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port }).Count -gt 0 }

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Desktop = Join-Path $Repo 'VideoAutoCutDesktop'
$Audit = Join-Path $Desktop 'node_modules\.tmp\ui-u6-51388993-314c52f-20260928'
$Phase = Join-Path $Audit 'phase-51391241-u7-1c307c3'
$Candidate = [IO.Path]::GetFullPath('D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut')
$ExpectedHead = '1c307c384a2ffaeed02bf29d5da55b671d3b59ab'
$ExpectedVersion = '3715aa42c0b71894dd62e0df28900b380aa5a43a'
$ExpectedCurrentSha = '4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21'
$ExpectedEngineSha = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
$ExpectedTapSha = '4c528f71fd1dbb8b181f8a9f91866018a2b654e02d24a93aa3cda8b6a409a4dc'
$Input = Join-Path $Repo 'docs\packaging-test-scripts-2026-09-21\07_表格版_混合_show判定_食品码垛_CN.xlsx'
$ExpectedInputSha = '32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e'
$CurrentPath = Join-Path $Audit 'data\runtime\current.json'
$RawRoot = Join-Path $Phase 'raw-electron-stdout'
$Receipts = Join-Path $Phase 'receipts'

$head = (& git -C $Repo rev-parse HEAD).Trim()
if ($head -ne $ExpectedHead) { throw "STOP: unexpected HEAD: $head" }
$status = @(& git -C $Repo status --short)
$expectedStatus = @(' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json')
if (($status -join "`n") -ne ($expectedStatus -join "`n")) { throw "STOP: unexpected git status: $($status -join '; ')" }
if (Test-TcpListener 9) { throw 'STOP: manifest-isolation port 9 acquired a listener' }
if (-not (Test-TcpListener 4173)) { throw 'STOP: isolated Vite port 4173 is not listening' }

$currentRaw = [IO.File]::ReadAllBytes($CurrentPath)
$strict = [Text.UTF8Encoding]::new($false, $true)
$currentSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($currentRaw)).ToLowerInvariant()
$readAt = (Get-Date).ToUniversalTime().ToString('o')
if ($currentSha -ne $ExpectedCurrentSha) { throw "STOP: current.json bytes changed: $currentSha" }
$current = $strict.GetString($currentRaw) | ConvertFrom-Json
if ([string]$current.version -ne $ExpectedVersion -or [IO.Path]::GetFullPath([string]$current.path) -ne $Candidate) { throw 'STOP: current runtime does not match frozen Candidate' }
if ((Get-Sha (Join-Path $Candidate 'VideoAutoCutEngine.exe')) -ne $ExpectedEngineSha) { throw 'STOP: Candidate engine SHA changed' }
if ((Get-Sha $Input) -ne $ExpectedInputSha) { throw 'STOP: frozen U7 input SHA changed' }
if ((Get-Sha (Join-Path $Phase 'scripts\electron-stdout-tap.cjs')) -ne $ExpectedTapSha) { throw 'STOP: observer module SHA changed' }
$downloadedEngines = @(Get-ChildItem -LiteralPath (Join-Path $Audit 'data\runtime') -Recurse -Filter 'VideoAutoCutEngine.exe' -File -ErrorAction Stop)
if ($downloadedEngines.Count -ne 0) { throw 'STOP: an engine appeared under isolated runtime data' }

$activations = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'activation-owner-*.json' -File)
$preflights = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'preflight-owner-*.json' -File)
$preflightFailures = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'preflight-owner-*-failure.json' -File)
$metadata = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'observer-*-metadata.json' -File)
if ($activations.Count -ne 1 -or $preflights.Count -ne 1 -or $preflightFailures.Count -ne 0 -or $metadata.Count -ne 1) { throw "STOP: activation/preflight/help count mismatch: activation=$($activations.Count), preflight=$($preflights.Count), failures=$($preflightFailures.Count), children=$($metadata.Count)" }
$activation = Get-Content -LiteralPath $activations[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
$preflight = Get-Content -LiteralPath $preflights[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [bool]$activation.builtin_spawn_patched -or [string]$activation.observer_module_sha256 -ne $ExpectedTapSha) { throw 'STOP: Electron owner did not activate expected observer' }
if (-not [bool]$preflight.esm_builtin_spawn_matches_patched_spawn -or [int]$preflight.exit_code -ne 0 -or [bool]$preflight.import_or_model_invocation) { throw 'STOP: Electron ESM spawn preflight failed' }

$safeCurrent = Join-Path $Receipts 'current-before-u7.json'
[IO.File]::WriteAllBytes($safeCurrent, $currentRaw)
$receipt = [ordered]@{
  schema = 'vacut-u7-phase-51391241-preimport/v1'
  checked_at = $readAt
  pass = $true
  source_head = $head
  current = [ordered]@{ path = $CurrentPath; copied_to = $safeCurrent; sha256 = $currentSha; last_write_utc = (Get-Item -LiteralPath $CurrentPath).LastWriteTimeUtc.ToString('o'); version = [string]$current.version; runtime_path = [string]$current.path }
  candidate_engine_sha256 = $ExpectedEngineSha
  input = [ordered]@{ path = $Input; sha256 = $ExpectedInputSha }
  safe_effective_defaults = [ordered]@{ parse_model = 'qwen-long'; review_model = 'qwen-long'; script_review = $true; http_attempt_limit = 5 }
  downloaded_engine_count_under_audit_runtime = 0
  manifest_isolation_listener_present = $false
  electron_owner = [ordered]@{ pid = [int]$activation.owner_pid; executable_basename = [string]$activation.owner_executable_basename; observer_sha256 = [string]$activation.observer_module_sha256; patched = [bool]$activation.builtin_spawn_patched }
  preflight = [ordered]@{ exit_code = [int]$preflight.exit_code; esm_spawn_matches_patch = [bool]$preflight.esm_builtin_spawn_matches_patched_spawn; import_or_model_invocation = [bool]$preflight.import_or_model_invocation }
  captured_children_before_click = 1
  gui_import_clicks_before = 0
  model_attempts_before = 0
}
[IO.File]::WriteAllText((Join-Path $Receipts 'pre-import-u7.json'), (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
