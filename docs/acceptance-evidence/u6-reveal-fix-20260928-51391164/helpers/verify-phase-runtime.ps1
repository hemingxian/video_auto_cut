param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('queue-folder','formal-u6','badshot')]
  [string]$Phase,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1,3)]
  [int]$ExpectedClosedChildren
)

$ErrorActionPreference = 'Stop'

function Get-Sha([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-TcpListener([int]$Port) {
  return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port }).Count -gt 0
}

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Audit = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928')
$PhaseRoot = Join-Path $Audit 'phase-51391164-5893f7d'
$Candidate = [IO.Path]::GetFullPath('D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut')
$ExpectedHead = '5893f7dc76bc87faa7c7907327807fb8893acb3d'
$ExpectedVersion = '3715aa42c0b71894dd62e0df28900b380aa5a43a'
$ExpectedCurrentSha = '4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21'
$ExpectedEngineSha = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
$ExpectedTapSha = '4c528f71fd1dbb8b181f8a9f91866018a2b654e02d24a93aa3cda8b6a409a4dc'
$ExpectedIpcBuildSha = 'a4e27d3f0974e9da97e6ffb787023167bae7e582c66eece92322315ac58ad0ef'
$ExpectedRevealBuildSha = '3e656a28571af9af52ca3873e49485ccec8b77ad4d4b81a618f3b3f86ee9eb15'
$CurrentPath = Join-Path $Audit 'data\runtime\current.json'
$RawRoot = Join-Path $PhaseRoot 'raw-electron-stdout'
$Receipts = Join-Path $PhaseRoot 'receipts'

$head = (& git -C $Repo rev-parse HEAD).Trim()
if ($head -ne $ExpectedHead) { throw "STOP: unexpected HEAD: $head" }
$status = @(& git -C $Repo status --short)
$expectedStatus = @(' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json')
if (($status -join "`n") -ne ($expectedStatus -join "`n")) { throw "STOP: unexpected git status: $($status -join '; ')" }
if (Test-TcpListener 9) { throw 'STOP: manifest-isolation port 9 acquired a listener' }
if (-not (Test-TcpListener 4173)) { throw 'STOP: isolated Vite port 4173 is not listening' }

$currentRaw = [IO.File]::ReadAllBytes($CurrentPath)
$currentSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($currentRaw)).ToLowerInvariant()
$currentReadAt = (Get-Date).ToUniversalTime().ToString('o')
if ($currentSha -ne $ExpectedCurrentSha) { throw "STOP: current.json bytes changed: $currentSha" }
$current = [Text.Encoding]::UTF8.GetString($currentRaw) | ConvertFrom-Json
if ([string]$current.version -ne $ExpectedVersion) { throw "STOP: unexpected current version: $($current.version)" }
if ([IO.Path]::GetFullPath([string]$current.path) -ne $Candidate) { throw "STOP: unexpected current runtime path: $($current.path)" }
if ((Get-Sha (Join-Path $Candidate 'VideoAutoCutEngine.exe')) -ne $ExpectedEngineSha) { throw 'STOP: Candidate engine SHA changed' }
if ((Get-Sha (Join-Path $PhaseRoot 'scripts\electron-stdout-tap.cjs')) -ne $ExpectedTapSha) { throw 'STOP: observer module SHA changed' }
if ((Get-Sha (Join-Path $Repo 'VideoAutoCutDesktop\dist-electron\ipc-handlers.js')) -ne $ExpectedIpcBuildSha) { throw 'STOP: fixed IPC build changed after launch' }
if ((Get-Sha (Join-Path $Repo 'VideoAutoCutDesktop\dist-electron\script-reveal.js')) -ne $ExpectedRevealBuildSha) { throw 'STOP: fixed reveal build changed after launch' }

$downloadedEngines = @(Get-ChildItem -LiteralPath (Join-Path $Audit 'data\runtime') -Recurse -Filter 'VideoAutoCutEngine.exe' -File -ErrorAction Stop)
if ($downloadedEngines.Count -ne 0) { throw 'STOP: an engine appeared under the isolated runtime data root' }
$activations = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'activation-owner-*.json' -File)
$preflights = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'preflight-owner-*.json' -File)
$preflightFailures = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'preflight-owner-*-failure.json' -File)
if ($activations.Count -ne 1 -or $preflights.Count -ne 1 -or $preflightFailures.Count -ne 0) {
  throw "STOP: activation/preflight count mismatch: activation=$($activations.Count), preflight=$($preflights.Count), failure=$($preflightFailures.Count)"
}
$activation = Get-Content -LiteralPath $activations[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
$preflight = Get-Content -LiteralPath $preflights[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [bool]$activation.builtin_spawn_patched -or [string]$activation.observer_module_sha256 -ne $ExpectedTapSha) {
  throw 'STOP: Electron owner did not activate the expected observer'
}
if (-not [bool]$preflight.esm_builtin_spawn_matches_patched_spawn -or [int]$preflight.exit_code -ne 0 -or [bool]$preflight.import_or_model_invocation) {
  throw 'STOP: Electron ESM spawn preflight failed'
}
$metadata = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'observer-*-metadata.json' -File | Sort-Object Name)
if ($metadata.Count -ne $ExpectedClosedChildren) {
  throw "STOP: expected $ExpectedClosedChildren closed captured children before $Phase, got $($metadata.Count)"
}

$safeCurrentSnapshot = Join-Path $Receipts "current-before-$Phase.json"
[IO.File]::WriteAllBytes($safeCurrentSnapshot, $currentRaw)
$receipt = [ordered]@{
  schema = 'vacut-u6-phase-51391164-5893f7d-runtime-gate/v1'
  phase = $Phase
  checked_at = $currentReadAt
  pass = $true
  source_head = $head
  current = [ordered]@{
    path = $CurrentPath
    copied_to = $safeCurrentSnapshot
    sha256 = $currentSha
    last_write_utc = (Get-Item -LiteralPath $CurrentPath).LastWriteTimeUtc.ToString('o')
    version = [string]$current.version
    runtime_path = [string]$current.path
  }
  candidate_engine_sha256 = $ExpectedEngineSha
  downloaded_engine_count_under_audit_runtime = 0
  manifest_isolation_listener_present = $false
  electron_owner = [ordered]@{
    pid = [int]$activation.owner_pid
    executable_basename = [string]$activation.owner_executable_basename
    process_type = [string]$activation.electron_process_type
    observer_sha256 = [string]$activation.observer_module_sha256
    patched = [bool]$activation.builtin_spawn_patched
  }
  preflight = [ordered]@{
    exit_code = [int]$preflight.exit_code
    esm_spawn_matches_patch = [bool]$preflight.esm_builtin_spawn_matches_patched_spawn
    import_or_model_invocation = [bool]$preflight.import_or_model_invocation
  }
  captured_closed_child_count_before_import = $metadata.Count
  expected_closed_child_count_before_import = $ExpectedClosedChildren
}
$receiptPath = Join-Path $Receipts "pre-import-$Phase.json"
[IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
