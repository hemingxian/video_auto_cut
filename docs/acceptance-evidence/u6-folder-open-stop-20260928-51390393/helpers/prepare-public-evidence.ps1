param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$AuthorizedSourceHead
)

$ErrorActionPreference = 'Stop'

function Get-Sha([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Sha([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing source: $Path" }
  $actual = Get-Sha $Path
  if ($actual -ne $Expected) { throw "Source SHA mismatch: $Path ($actual)" }
}
function Write-Lf([string]$Path, [string]$Text) {
  $normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  [IO.File]::WriteAllText($Path, $normalized, [Text.UTF8Encoding]::new($false))
}

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Prep = Join-Path $Repo 'VideoAutoCutDesktop\node_modules\.tmp\u6-folder-open-stop-docs-prep-51390393'
$Phase = Join-Path $Repo 'VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928\phase-51390393'
$Target = Join-Path $Repo 'docs\acceptance-evidence\u6-folder-open-stop-20260928-51390393'
$Candidate = 'D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut'
$ExpectedHead = '4d62e25965cbae0bd25f53ff2c45881082c87db6'
$Python = Join-Path $Candidate 'python-3.11.9-embed-amd64\python.exe'

if ($AuthorizedSourceHead -ne $ExpectedHead) { throw "Not authorized for source $AuthorizedSourceHead" }
$actualHead = (& git -C $Repo rev-parse HEAD).Trim()
if ($actualHead -ne $ExpectedHead) { throw "Unexpected HEAD: $actualHead" }
$status = @(& git -C $Repo status --short)
$expectedStatus = @(' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json')
if (($status -join "`n") -ne ($expectedStatus -join "`n")) { throw "Unexpected git status: $($status -join '; ')" }
if (Test-Path -LiteralPath $Target) { throw "Refuse to overwrite evidence target: $Target" }

$fixedSources = @(
  @{ Path = Join-Path $Phase 'receipts\STOP-folder-open.json'; Sha = '2ee3453245de7af0b226aed0874ba2796b65acfdf20c164e48cddc5741182e37' },
  @{ Path = Join-Path $Phase 'receipts\shutdown.json'; Sha = '2cc8714fc9977004b9648b22e1c3748dfa0f4e5eeccf06a2c5406ab31058e994' },
  @{ Path = Join-Path $Phase 'receipts\window-inventory-after-folder-click.json'; Sha = 'd63a818223922ab8ac6f5d12bdaaea7e5472eacdcacd91a89162112f5e60add8' },
  @{ Path = Join-Path $Phase 'receipts\current-post-stop.json'; Sha = '4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21' },
  @{ Path = Join-Path $Phase 'receipts\captured-import-formal-u6.json'; Sha = 'b1c1c0383942be55e347869a1dd8353309dc8c04a133f1eb870c5e5147446877' },
  @{ Path = Join-Path $Phase 'receipts\ai-lines-formal-u6.json'; Sha = '4554567ac760e698e878e8c23292dcfc55bf4c09b83e851b2499a983cb323ed9' },
  @{ Path = Join-Path $Phase 'logs\launcher.stdout.log'; Sha = '20f9cc9882115e2b7e8a6a68f6c5fd6206e23b416d353ad68a3e17097728ad43' },
  @{ Path = Join-Path $Phase 'logs\launcher.stderr.log'; Sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  @{ Path = Join-Path $Repo '.codex-handoff\root-review-u6-folder-stop-51390393.py'; Sha = '18f70e59a3b7258f77a398b44a6bb45193c9a70731a611ca2d2ca3a777a359ce' },
  @{ Path = Join-Path $Repo '.codex-handoff\root-review-u6-folder-stop-51390393.json'; Sha = '80d57f105f12c2c3e28484c53e81b909fcb762bc3722e5fc5d4c551357fd02dd' }
)
foreach ($item in $fixedSources) { Assert-Sha $item.Path $item.Sha }

$secretPattern = '(?i)(authorization\s*:|bearer\s+[a-z0-9._-]+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])'
$secretHits = @(Select-String -LiteralPath (Join-Path $Phase 'logs\launcher.stdout.log'),(Join-Path $Phase 'logs\launcher.stderr.log') -Pattern $secretPattern)
if ($secretHits.Count -ne 0) { throw "Refuse public export: launcher logs contain $($secretHits.Count) credential-pattern hits" }

$dirs = @($Target, (Join-Path $Target 'raw'), (Join-Path $Target 'receipts'), (Join-Path $Target 'screenshots'), (Join-Path $Target 'helpers'))
New-Item -ItemType Directory -Path $dirs | Out-Null
Write-Lf (Join-Path $Target '.gitattributes') "* -text`n"
Copy-Item -LiteralPath (Join-Path $Prep 'DRAFT-README.md') -Destination (Join-Path $Target 'README.md')

$copyMap = [ordered]@{
  'receipts\STOP-folder-open.json' = 'receipts\STOP-folder-open.json'
  'receipts\shutdown.json' = 'receipts\shutdown.json'
  'receipts\captured-import-formal-u6.json' = 'receipts\captured-import-formal-u6.json'
  'receipts\ai-lines-formal-u6.json' = 'receipts\ai-lines-formal-u6.json'
  'receipts\pre-import-formal-u6.json' = 'receipts\pre-import-formal-u6.json'
  'receipts\current-before-formal-u6.json' = 'receipts\current-before-formal-u6.json'
  'receipts\current-post-stop.json' = 'receipts\current-post-stop.json'
  'receipts\launch-environment.json' = 'receipts\launch-environment.json'
  'raw-electron-stdout\activation-owner-5836.json' = 'raw\activation-owner-5836.json'
  'raw-electron-stdout\preflight-owner-5836.json' = 'raw\preflight-owner-5836.json'
  'raw-electron-stdout\observer-5836-seq-1-child-38944-metadata.json' = 'raw\help-metadata.json'
  'raw-electron-stdout\observer-5836-seq-1-child-38944-stdout.bin' = 'raw\help-stdout.bin'
  'raw-electron-stdout\observer-5836-seq-1-child-38944-stderr.bin' = 'raw\help-stderr.bin'
  'raw-electron-stdout\observer-5836-seq-1-child-38944-vacut-events.bin' = 'raw\help-vacut-events.bin'
  'raw-electron-stdout\observer-5836-seq-2-child-13448-metadata.json' = 'raw\formal-metadata.json'
  'raw-electron-stdout\observer-5836-seq-2-child-13448-stdout.bin' = 'raw\formal-stdout.bin'
  'raw-electron-stdout\observer-5836-seq-2-child-13448-stderr.bin' = 'raw\formal-stderr.bin'
  'raw-electron-stdout\observer-5836-seq-2-child-13448-vacut-events.bin' = 'raw\formal-vacut-events.bin'
  'logs\launcher.stdout.log' = 'raw\launcher.stdout.log'
  'logs\launcher.stderr.log' = 'raw\launcher.stderr.log'
}
foreach ($entry in $copyMap.GetEnumerator()) {
  $source = Join-Path $Phase ([string]$entry.Key)
  $destination = Join-Path $Target ([string]$entry.Value)
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source: $source" }
  Copy-Item -LiteralPath $source -Destination $destination
  if ((Get-Sha $source) -ne (Get-Sha $destination)) { throw "Byte copy mismatch: $source" }
}
Copy-Item -LiteralPath (Join-Path $Repo '.codex-handoff\root-review-u6-folder-stop-51390393.json') -Destination (Join-Path $Target 'receipts\root-review-u6-folder-stop-51390393.json')
Copy-Item -LiteralPath (Join-Path $Repo '.codex-handoff\root-review-u6-folder-stop-51390393.py') -Destination (Join-Path $Target 'helpers\root-review-u6-folder-stop-51390393.py')

$fullInventoryPath = Join-Path $Phase 'receipts\window-inventory-after-folder-click.json'
$fullInventory = Get-Content -LiteralPath $fullInventoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$related = @($fullInventory.windows | Where-Object {
  ([string]$_.app -eq 'process:D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\electron\dist\electron.exe') -or
  ([string]$_.app -eq 'process:C:\Windows\explorer.exe')
})
$derived = [ordered]@{
  schema = 'vacut-sky-window-inventory-derived/v1'
  derived = $true
  source_private_inventory_sha256 = Get-Sha $fullInventoryPath
  source_private_inventory_not_published = $true
  filter = 'isolated Electron app path plus Windows Explorer entries only'
  expected_folder_title = 'script-template-v1 - 文件资源管理器'
  expected_folder_present = $false
  entries = $related
}
$derivedPath = Join-Path $Target 'receipts\window-inventory.derived.json'
Write-Lf $derivedPath (($derived | ConvertTo-Json -Depth 8) + "`n")

$secretScan = [ordered]@{
  schema = 'vacut-public-log-secret-scan/v1'
  files = @('raw/launcher.stdout.log','raw/launcher.stderr.log')
  patterns = @('authorization header','bearer token','api key assignment','access token assignment')
  matches = 0
  safe_to_copy = $true
}
Write-Lf (Join-Path $Target 'receipts\raw-secret-scan.json') (($secretScan | ConvertTo-Json -Depth 5) + "`n")

$timeline = [ordered]@{
  schema = 'vacut-u6-folder-stop-operator-timeline/v1'
  entries = @(
    [ordered]@{ at_utc = '2026-09-28T08:08:27.2801422Z'; action = 'isolated launcher started' },
    [ordered]@{ at_utc = '2026-09-28T08:09:49.7546070Z'; action = 'formal pre-import runtime gate passed' },
    [ordered]@{ at_utc = '2026-09-28T08:10:24.803Z'; action = 'formal import clicked once' },
    [ordered]@{ at_local = '2026-09-28T16:10:59+08:00'; action = 'folder button click rejected; launcher/Vite log timestamp' },
    [ordered]@{ at_utc = '2026-09-28T08:13:30.879Z'; action = 'official Sky Alt+F4 sent to isolated window' }
  )
  badshot_imports = 0
  u7_imports = 0
  model_calls = 0
}
Write-Lf (Join-Path $Target 'operator-timeline.json') (($timeline | ConvertTo-Json -Depth 8) + "`n")

$imageMap = [ordered]@{
  'U6-queue-absent-before-formal.jpg' = 'U6-queue-absent-before-formal.png'
  'U6-formal-main-failed.jpg' = 'U6-formal-main-failed.png'
  'U6-formal-queue-blocked2-before-folder.jpg' = 'U6-formal-queue-blocked2-before-folder.png'
  'U6-formal-queue-after-folder-error.jpg' = 'U6-formal-queue-after-folder-error.png'
  'U6-folder-click-existing-explorer-video-auto-cut.jpg' = 'U6-folder-click-existing-explorer-video-auto-cut.png'
}
foreach ($entry in $imageMap.GetEnumerator()) {
  $source = Join-Path $Phase 'screenshots' ([string]$entry.Key)
  $png = Join-Path $Target 'screenshots' ([string]$entry.Value)
  $receipt = "$png.pixel-equivalence.json"
  & $Python (Join-Path $Prep 'convert-screenshot.py') --source $source --png $png --receipt $receipt
  if ($LASTEXITCODE -ne 0) { throw "Screenshot conversion failed: $source" }
}

Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Target 'helpers\prepare-public-evidence.ps1')
Copy-Item -LiteralPath (Join-Path $Prep 'convert-screenshot.py') -Destination (Join-Path $Target 'helpers\convert-screenshot.py')
Copy-Item -LiteralPath (Join-Path $Phase 'scripts\verify-phase-capture.ps1') -Destination (Join-Path $Target 'helpers\verify-phase-capture.ps1')
Copy-Item -LiteralPath (Join-Path $Phase 'scripts\verify-phase-runtime.ps1') -Destination (Join-Path $Target 'helpers\verify-phase-runtime.ps1')
Copy-Item -LiteralPath (Join-Path $Phase 'scripts\electron-stdout-tap.cjs') -Destination (Join-Path $Target 'helpers\electron-stdout-tap.cjs')

$payload = @(Get-ChildItem -LiteralPath $Target -File -Recurse | Where-Object { $_.Name -notin @('artifact-manifest.json','SHA256SUMS.txt') } | Sort-Object FullName)
$manifest = [ordered]@{
  schema = 'vacut-evidence-artifact-manifest/v1'
  source_head = $ExpectedHead
  source_private_audit = 'VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928/phase-51390393'
  excludes = @('artifact-manifest.json','SHA256SUMS.txt')
  files = @($payload | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($Target, $_.FullName).Replace('\','/'); bytes = $_.Length; sha256 = Get-Sha $_.FullName }
  })
}
$manifestPath = Join-Path $Target 'artifact-manifest.json'
Write-Lf $manifestPath (($manifest | ConvertTo-Json -Depth 8) + "`n")

$sumFiles = @($payload + (Get-Item -LiteralPath $manifestPath) | Sort-Object FullName)
$sumLines = @($sumFiles | ForEach-Object { "$(Get-Sha $_.FullName)  $([IO.Path]::GetRelativePath($Target, $_.FullName).Replace('\','/'))" })
Write-Lf (Join-Path $Target 'SHA256SUMS.txt') (($sumLines -join "`n") + "`n")

[ordered]@{
  status = 'public_evidence_prepared_not_staged'
  target = $Target
  source_head = $ExpectedHead
  files = @(Get-ChildItem -LiteralPath $Target -File -Recurse).Count
  screenshots = $imageMap.Count
  excluded_private_screenshot = 'U6-folder-click-existing-explorer-review-page.jpg'
  model_calls = 0
  staged = $false
  committed = $false
  pushed = $false
} | ConvertTo-Json -Depth 5
