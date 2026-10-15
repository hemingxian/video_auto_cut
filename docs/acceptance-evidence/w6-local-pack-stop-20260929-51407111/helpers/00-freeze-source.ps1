param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$AuthorizedSourceHead
)

. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')

if (Test-Path -LiteralPath $script:SourceLockPath) { throw "SOURCE-LOCK 已存在，拒绝覆盖：$($script:SourceLockPath)" }
Assert-FullSha $AuthorizedSourceHead
$currentHead = Get-GitScalar @('rev-parse', 'HEAD')
if ($currentHead -ne $AuthorizedSourceHead) { throw "root 释放 SHA 与当前 HEAD 不同：释放=$AuthorizedSourceHead 当前=$currentHead" }
if ((Get-GitScalar @('branch', '--show-current')) -ne $script:Branch) { throw '分支不符' }
if ((Get-GitScalar @('rev-parse', 'master')) -ne $script:Master) { throw 'master 不符' }
Assert-MainWorkingTree
$protectedSnapshot = @(Get-ProtectedSnapshot)

& git -C $script:RepoRoot diff --quiet "$($script:RuntimeProductionAnchor)..$AuthorizedSourceHead" -- VideoAutoCut VideoAutoCutApp
if ($LASTEXITCODE -ne 0) { throw '311d5e5 之后 VideoAutoCut/VideoAutoCutApp 有变化；不再是冻结 runtime 输入' }

$toolPaths = @(Get-GitLines @('ls-tree', '-r', '--name-only', $AuthorizedSourceHead, '--', 'VideoAutoCut/tools'))
if ($toolPaths.Count -ne 157) { throw "tracked tools 不是 157：$($toolPaths.Count)" }

$blobReceipt = @()
foreach ($entry in $script:ExpectedBlobs.GetEnumerator()) {
  $actual = Get-GitScalar @('rev-parse', "$AuthorizedSourceHead`:$($entry.Key)")
  if ($actual -ne $entry.Value) { throw "冻结脚本 blob 变化：$($entry.Key)" }
  $blobReceipt += [ordered]@{ path = $entry.Key; blob = $actual }
}

$packageBytes = & git -C $script:RepoRoot show "$AuthorizedSourceHead`:VideoAutoCutDesktop/package.json"
if ($LASTEXITCODE -ne 0) { throw '无法读取源 HEAD package.json' }
$package = (($packageBytes | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
$expectedPackScript = 'npm run build:scripts && node dist-scripts/pack-release.js --runtime'
if ($package.scripts.'release:pack:runtime' -ne $expectedPackScript) { throw '源 HEAD runtime pack script 不符' }

$forbiddenNames = @('.env', 'app.env', 'auth.json', 'device.json', 'downloaded.txt', 'VideoAuto_last_run.log')
$mapped = @(Get-GitLines @('ls-tree', '-r', '--name-only', $AuthorizedSourceHead, '--', 'VideoAutoCut/tools', 'VideoAutoCut/config', 'VideoAutoCut/sentrysearch', 'VideoAutoCut/fonts', 'VideoAutoCutApp/prompts'))
$forbiddenTracked = @($mapped | Where-Object { $forbiddenNames -contains [System.IO.Path]::GetFileName($_) })
if ($forbiddenTracked.Count -ne 0) { throw "源 HEAD 映射目录含敏感配置文件名：`n$($forbiddenTracked -join "`n")" }

if ((Get-Sha256 $script:MaterialOracle) -ne 'c2d18ec367ec69017b71cf2f1f3a2f41e8dc9240b509cf37b6f0197f3b6f0948') {
  throw '六素材 oracle SHA 变化'
}
$oracle = Get-Content -LiteralPath $script:MaterialOracle -Raw -Encoding utf8 | ConvertFrom-Json
$unique = [ordered]@{}
foreach ($shot in @($oracle.shots)) {
  foreach ($material in @($shot.materials)) {
    $unique[[string]$material.source_sha256] = $material
  }
}
if ($unique.Count -ne 6) { throw "六素材去重数量不为 6：$($unique.Count)" }
$materialReceipt = @()
foreach ($pair in $unique.GetEnumerator() | Sort-Object Key) {
  $material = $pair.Value
  if (-not (Test-Path -LiteralPath $material.local_path -PathType Leaf)) { throw "冻结素材缺失：$($material.material_id)" }
  $actual = Get-Sha256 $material.local_path
  if ($actual -ne [string]$material.source_sha256) { throw "冻结素材 SHA 不符：$($material.material_id)" }
  $file = Get-Item -LiteralPath $material.local_path
  $materialReceipt += [ordered]@{
    material_id = $material.material_id
    asset_id = $material.asset_id
    asset_version = $material.asset_version
    source_sha256 = $actual
    bytes = [int64]$file.Length
  }
}

$short = $AuthorizedSourceHead.Substring(0, 12)
$worktree = "D:\autocut\video-auto-cut-w6-51407111-$short"
$worktreeZip = Join-Path $worktree "VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-$($script:RuntimeVersion).zip"
$worktreeManifest = Join-Path $worktree 'VideoAutoCutDesktop\runtime-release\manifest.json'
if (Test-Path -LiteralPath $worktree) { throw "隔离 worktree 目标已存在：$worktree" }
if (Test-Path -LiteralPath $worktreeZip) { throw "隔离 pkg5 已存在：$worktreeZip" }

$frozenInputs = [ordered]@{
  source_head = $AuthorizedSourceHead
  runtime_production_anchor = $script:RuntimeProductionAnchor
  tracked_tools_count = $toolPaths.Count
  pack_and_check_blobs = $blobReceipt
  forbidden_tracked_sensitive_names = @()
  material_oracle_sha256 = Get-Sha256 $script:MaterialOracle
  unique_material_count = $materialReceipt.Count
  materials = $materialReceipt
}
Write-Json (Join-Path $script:AuditRoot 'FROZEN-INPUTS.json') $frozenInputs
Write-Json (Join-Path $script:AuditRoot 'protected-main-before.json') $protectedSnapshot

$lock = [ordered]@{
  schema = 1
  authorized_instruction = 51407111
  source_head = $AuthorizedSourceHead
  source_head_full = $true
  branch = $script:Branch
  master = $script:Master
  runtime_version = $script:RuntimeVersion
  runtime_base = $script:BaseRuntime
  worktree = $worktree
  worktree_zip = $worktreeZip
  worktree_manifest = $worktreeManifest
  main_manifest = $script:MainManifest
  main_manifest_sha256_must_remain = $script:ProtectedSpecs.main_manifest.sha256
  committed_package_only = $true
  copy_user_dirty_package_files = $false
  desktop_node_modules_strategy = 'junction_read_only_to_main_Desktop_node_modules; tool node_modules remain physical and isolated inside worktree'
  worktree_created = $false
  pack_executed = $false
}
Write-Json $script:SourceLockPath $lock
Write-Output 'SOURCE FREEZE PASS：只写审计收据；未创建 worktree，未安装、探针、构建或打包。'
