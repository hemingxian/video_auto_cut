param(
  [Parameter(Mandatory = $true)]
  [string]$AuthorizedHead
)

$ErrorActionPreference = 'Stop'

function Get-Sha([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Phase = Join-Path $Repo 'VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928\phase-51391164-5893f7d'
$TestRoot = Join-Path $Repo 'VideoAutoCutDesktop\node_modules\.tmp\script-reveal-51391164-25fcd89-20260928'
$Target = Join-Path $Repo 'docs\acceptance-evidence\u6-reveal-fix-20260928-51391164'
$ExpectedHead = '5893f7dc76bc87faa7c7907327807fb8893acb3d'
if ($AuthorizedHead -ne $ExpectedHead) { throw 'Authorized HEAD does not match the fixed U6 source' }
if ((& git -C $Repo rev-parse HEAD).Trim() -ne $ExpectedHead) { throw 'Repository HEAD changed before evidence preparation' }
if (Test-Path -LiteralPath $Target) { throw "Refuse to overwrite evidence target: $Target" }

$dirs = @($Target, (Join-Path $Target 'raw'), (Join-Path $Target 'receipts'), (Join-Path $Target 'helpers'), (Join-Path $Target 'logs'), (Join-Path $Target 'screenshots'), (Join-Path $Target 'tests'))
New-Item -ItemType Directory -Path $dirs | Out-Null
[IO.File]::WriteAllText((Join-Path $Target '.gitattributes'), "* -text`n", [Text.UTF8Encoding]::new($false))

$rawNames = @(
  'activation-owner-34724.json',
  'preflight-owner-34724.json',
  'observer-34724-seq-1-child-42532-metadata.json',
  'observer-34724-seq-1-child-42532-stdout.bin',
  'observer-34724-seq-1-child-42532-stderr.bin',
  'observer-34724-seq-1-child-42532-vacut-events.bin',
  'observer-34724-seq-2-child-42160-metadata.json',
  'observer-34724-seq-2-child-42160-stdout.bin',
  'observer-34724-seq-2-child-42160-stderr.bin',
  'observer-34724-seq-2-child-42160-vacut-events.bin',
  'observer-34724-seq-3-child-42308-metadata.json',
  'observer-34724-seq-3-child-42308-stdout.bin',
  'observer-34724-seq-3-child-42308-stderr.bin',
  'observer-34724-seq-3-child-42308-vacut-events.bin'
)

$receiptNames = @(
  'phase-preparation.json',
  'phase-artifacts.json',
  'launch-environment.json',
  'current-before-queue-folder.json',
  'current-before-formal-u6.json',
  'current-before-badshot.json',
  'current-after-badshot.json',
  'pre-import-queue-folder.json',
  'pre-import-formal-u6.json',
  'pre-import-badshot.json',
  'captured-import-formal-u6.json',
  'captured-import-badshot.json',
  'ai-lines-formal-u6.json',
  'ai-lines-badshot.json',
  'pre-shutdown-identity-and-log-scan.json',
  'shutdown.json'
)

$helperNames = @(
  'PREP-README.md',
  'start-phase-51391164.ps1',
  'verify-phase-runtime.ps1',
  'verify-phase-capture.ps1',
  'electron-stdout-tap.cjs',
  'convert-screenshots.py',
  'prepare-public-evidence.ps1'
)

$screenshotBases = @(
  'queue-empty-visible-before-formal',
  'formal-drawer-before-import-no-range-selected',
  'formal-main-failed',
  'formal-queue-two-blocked',
  'formal-app-after-folder-click',
  'formal-explorer-target-window-selected-workbook',
  'badshot-main-failed',
  'badshot-queue-a2-minus1'
)

$testNames = @(
  'baseline-behavior-red.log',
  'baseline-script-reveal-harness.mjs',
  'after-review-focused-final.log',
  'after-review-focused-final-exit.txt',
  'after-review-full-final.log',
  'after-review-full-final-exit.txt',
  'after-review-change-build.log',
  'after-review-change-build-exit.txt',
  'after-review-test-lint-final-exit.txt'
)

foreach ($name in $rawNames) {
  Copy-Item -LiteralPath (Join-Path $Phase 'raw-electron-stdout' $name) -Destination (Join-Path $Target 'raw' $name)
}
foreach ($name in $receiptNames) {
  Copy-Item -LiteralPath (Join-Path $Phase 'receipts' $name) -Destination (Join-Path $Target 'receipts' $name)
}
Copy-Item -LiteralPath (Join-Path $Repo '.codex-handoff\root-review-formal-51391164.json') -Destination (Join-Path $Target 'receipts\root-review-formal-51391164.json')
Copy-Item -LiteralPath (Join-Path $Repo '.codex-handoff\root-review-badshot-51391164.json') -Destination (Join-Path $Target 'receipts\root-review-badshot-51391164.json')
foreach ($name in $helperNames) {
  Copy-Item -LiteralPath (Join-Path $Phase 'scripts' $name) -Destination (Join-Path $Target 'helpers' $name)
}
Copy-Item -LiteralPath (Join-Path $Phase 'logs\launcher.stdout.log') -Destination (Join-Path $Target 'logs\launcher.stdout.log')
Copy-Item -LiteralPath (Join-Path $Phase 'logs\launcher.stderr.log') -Destination (Join-Path $Target 'logs\launcher.stderr.log')
foreach ($base in $screenshotBases) {
  foreach ($extension in @('.jpeg', '.png')) {
    Copy-Item -LiteralPath (Join-Path $Phase 'screenshots' ($base + $extension)) -Destination (Join-Path $Target 'screenshots' ($base + $extension))
  }
}
foreach ($name in $testNames) {
  Copy-Item -LiteralPath (Join-Path $TestRoot $name) -Destination (Join-Path $Target 'tests' $name)
}

$fixValidation = [ordered]@{
  schema = 'vacut-script-reveal-fix-validation/v1'
  parent_head = '25fcd892e6ada40e2498e28e5aff9b7af26a0f71'
  fixed_head = $ExpectedHead
  before = [ordered]@{
    behavior_log = 'tests/baseline-behavior-red.log'
    harness = 'tests/baseline-script-reveal-harness.mjs'
    task_start_ok = $true
    dedicated_script_reveal_registered = $false
    old_blocked_button_used_workspace_folder_open = $true
    old_workspace_guard_rejected_external_script_parent = $true
    expected_assertion_failed = $true
  }
  after = [ordered]@{
    focused = [ordered]@{ tests = 55; pass = 55; fail = 0; skipped = 0; exit_code = 0; log = 'tests/after-review-focused-final.log' }
    full = [ordered]@{ tests = 421; pass = 419; fail = 0; skipped = 2; exit_code = 0; log = 'tests/after-review-full-final.log' }
    build = [ordered]@{ exit_code = 0; log = 'tests/after-review-change-build.log' }
    changed_lint = [ordered]@{ exit_code = 0; log_not_persisted = $true; exit_receipt = 'tests/after-review-test-lint-final-exit.txt' }
  }
}
[IO.File]::WriteAllText((Join-Path $Target 'tests\fix-validation.json'), (($fixValidation | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

$privatePixelIndex = Get-Content -LiteralPath (Join-Path $Phase 'receipts\screenshot-png-index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$publicMappings = foreach ($base in $screenshotBases) {
  $mapping = @($privatePixelIndex.mappings | Where-Object { [IO.Path]::GetFileNameWithoutExtension([string]$_.source) -eq $base })
  if ($mapping.Count -ne 1 -or -not [bool]$mapping[0].decoded_pixels_equal) { throw "Screenshot mapping mismatch: $base" }
  [ordered]@{
    jpeg = "screenshots/$base.jpeg"
    jpeg_sha256 = [string]$mapping[0].source_sha256
    png = "screenshots/$base.png"
    png_sha256 = [string]$mapping[0].png_sha256
    decoded_mode = [string]$mapping[0].decoded_mode
    width = [int]$mapping[0].width
    height = [int]$mapping[0].height
    decoded_pixels_equal = $true
  }
}
$pixelReceipt = [ordered]@{
  schema = 'vacut-u6-public-screenshot-pixels/v1'
  count = $publicMappings.Count
  all_decoded_pixels_equal = $true
  mappings = @($publicMappings)
  excluded_private_sources = @(
    [ordered]@{ name = 'queue-absent-before-formal.jpeg'; sha256 = '7dba8509e6881315bdcb9cdb99092467081b9db25e619ba39b0aa67043b5cfad'; reason = 'loading-only blank frame; does not prove queue state' },
    [ordered]@{ name = 'formal-explorer-selected-workbook.jpeg'; sha256 = 'a4a84ae4cdfed871555b17b2ad8571abc6cb2b5706fc56b69472a2900de981b0'; reason = 'full desktop contains unrelated windows; replaced publicly by the official Sky target-window screenshot' }
  )
}
[IO.File]::WriteAllText((Join-Path $Target 'receipts\screenshot-pixels.json'), (($pixelReceipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

$ledger = [ordered]@{
  schema = 'vacut-u6-51391164-invocation-ledger/v1'
  source_head = $ExpectedHead
  candidate_engine_sha256 = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
  invocations = @(
    [ordered]@{ sequence = 1; kind = 'engine_help_preflight'; gui_import = $false; qwen = 0; model_api = 0; exit_code = 0 },
    [ordered]@{ sequence = 2; kind = 'formal_u6_gui_import'; input_sha256 = '64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63'; gui_import = $true; qwen = 0; model_api = 0; outer_exit_code = 1; inner_exit_code = 2 },
    [ordered]@{ sequence = 3; kind = 'synthetic_badshot_gui_import'; input_sha256 = '81a76914dc7131ca818a545816c0b8dc8b71406c1653bc2c96228ff8f9acb761'; gui_import = $true; qwen = 0; model_api = 0; outer_exit_code = 1; inner_exit_code = 2 }
  )
  formal_folder_button_clicks = 1
  badshot_folder_button_clicks = 0
  generate_clicks = 0
  totals = [ordered]@{ help_preflight = 1; gui_imports = 2; qwen = 0; model_api = 0; generate = 0 }
}
[IO.File]::WriteAllText((Join-Path $Target 'invocation-ledger.json'), (($ledger | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

$readme = @'
# U6 dedicated script reveal revalidation (51391164)

Source commit `5893f7dc76bc87faa7c7907327807fb8893acb3d` revalidated the dedicated `script:reveal` path in the real isolated Electron UI. The frozen Candidate engine remained `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`; the isolated `current.json` stayed byte-identical before both imports and after completion.

## Result

- PASS: the preserved queue was visibly empty, so the one authorized formal import was used.
- PASS: the frozen formal workbook produced the exact template result: 8 shots, 2 blocked items, 53 warnings (`43 ai_suggested`, `8 status_pending`, `2 status_note`), outer engine exit 1 and inner `normalize_script` exit 2. The queue card shows shot 8 at `I9 / 口播` and `K9 / 上屏文字`.
- PASS: `打开所在文件夹` was clicked exactly once. A new Explorer window opened at `D:/autocut/video-auto-cut/docs/script-template-v1` with `转换演示_v1表格.xlsx` selected. Final launcher logs contain no `script:reveal`, `folder:open`, rejection, or error match.
- PASS: the original synthetic bad-shot fixture produced one blocked item and no warnings: `A2 / -1 / 镜号 / shot_no_invalid`.
- Model calls were zero. The formal stdout contains only the 43 allowed static `ai_suggested` lines plus the corresponding event line. The bad-shot stdout contains no literal `AI` line. No Qwen, DashScope, 百炼, model API, or model-name marker was observed.
- The script drawer did expose `统一设置素材范围` and per-script `绑定素材` controls. No material scope was selected for these U6 parser/reveal checks. The formal task stopped at 3% while reading the script, before material matching. This evidence does not claim that a range was selected.

## Fix validation

The behavioral baseline at parent `25fcd892e6ada40e2498e28e5aff9b7af26a0f71` records a successful `task:start`, the missing dedicated `script:reveal` handler, the old blocked-card wiring through workspace `folder:open`, and the workspace guard rejection for the external frozen script. The final fix at `5893f7dc76bc87faa7c7907327807fb8893acb3d` passed the focused suite (55/55, no skips), full suite (421 total, 419 passed, 0 failed, 2 pre-existing skips), build, and changed-file lint. The changed-file lint command output was not persisted; its exact exit receipt is included and this package does not claim a missing log exists. See `tests/fix-validation.json` and the copied original logs.

The UI label `v0.5.14` comes from the user's pre-existing dirty Desktop package files. It is distinct from the frozen Candidate engine identity above. Those two package files remained the only working-tree changes and were not staged or modified by this run.

## Evidence notes

Raw Electron-received stdout, stderr, VACUT events, metadata, and the zero-import help preflight are copied byte-for-byte under `raw/`. `.gitattributes` disables text conversion so their original line endings remain intact. Independent root receipts are under `receipts/`.

Each published native screenshot includes the original Sky JPEG and a PNG with identical decoded pixels. `receipts/screenshot-pixels.json` records the mapping. Two private images are intentionally excluded: the initial loading-only blank frame cannot prove an empty queue, and the first Explorer capture included unrelated desktop windows. The published Explorer image is the separate official Sky target-window screenshot, not a crop or reconstruction.

The isolated app was closed naturally through official Computer Use `Alt+F4`. Electron and its launcher exited, ports 4173 and 9 had no listener, and all six protected hashes remained unchanged. U7, Generate, food E2E, W6, cleanup, engine publication, and master merge were not run in this evidence phase.
'@
[IO.File]::WriteAllText((Join-Path $Target 'README.md'), ($readme.TrimEnd() + "`n"), [Text.UTF8Encoding]::new($false))

$payloadFiles = @(Get-ChildItem -LiteralPath $Target -File -Recurse | Where-Object { $_.Name -notin @('artifact-manifest.json','SHA256SUMS') } | Sort-Object FullName)
$manifest = [ordered]@{
  schema = 'vacut-u6-51391164-artifact-manifest/v1'
  source_head = $ExpectedHead
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  payload_count = $payloadFiles.Count
  files = @($payloadFiles | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($Target, $_.FullName).Replace('\','/'); bytes = $_.Length; sha256 = Get-Sha $_.FullName }
  })
}
[IO.File]::WriteAllText((Join-Path $Target 'artifact-manifest.json'), (($manifest | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

$sumFiles = @(Get-ChildItem -LiteralPath $Target -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS' } | Sort-Object FullName)
$sumLines = @($sumFiles | ForEach-Object { "$(Get-Sha $_.FullName)  $([IO.Path]::GetRelativePath($Target, $_.FullName).Replace('\','/'))" })
[IO.File]::WriteAllText((Join-Path $Target 'SHA256SUMS'), (($sumLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))

[ordered]@{
  target = $Target
  total_files = @(Get-ChildItem -LiteralPath $Target -File -Recurse).Count
  manifest_payload = $manifest.payload_count
  sha256sum_lines = $sumLines.Count
  source_head = $ExpectedHead
} | ConvertTo-Json -Depth 5
