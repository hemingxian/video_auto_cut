param()

. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')

$lock = Read-SourceLock
Assert-MainLocked $lock 'finalize-worktree-entry'
$statePath = Get-StatePath
if (Test-Path -LiteralPath $statePath) { throw "状态已存在，拒绝补写：$statePath" }
if (-not (Test-Path -LiteralPath $lock.worktree -PathType Container)) { throw "既有 worktree 不存在：$($lock.worktree)" }
if (Test-Path -LiteralPath $lock.worktree_zip) { throw "pkg5 已存在：$($lock.worktree_zip)" }
if (Test-Path -LiteralPath $lock.worktree_manifest) { throw "隔离 manifest 目标已存在：$($lock.worktree_manifest)" }
Assert-IsolatedWorktree $lock 'finalize-existing-worktree'

$mainNodeModules = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\node_modules'
$worktreeNodeModules = Join-Path $lock.worktree 'VideoAutoCutDesktop\node_modules'
$junction = Get-Item -LiteralPath $worktreeNodeModules -Force
if (($junction.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Desktop node_modules 不是 junction' }
$junctionTargets = @($junction.Target)
if ($junctionTargets.Count -ne 1 -or -not [string]::Equals([System.IO.Path]::GetFullPath([string]$junctionTargets[0]), [System.IO.Path]::GetFullPath($mainNodeModules), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Desktop node_modules junction 未精确指向主依赖目录'
}

$piModules = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\pi\node_modules'
$hfModules = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\hyperframes\node_modules'
if (Test-Path -LiteralPath $piModules) { throw "Pi node_modules 已存在，不能证明未安装：$piModules" }
if (Test-Path -LiteralPath $hfModules) { throw "HyperFrames node_modules 已存在，不能证明未安装：$hfModules" }

& git -C $lock.worktree check-ignore -q -- 'VideoAutoCutDesktop/runtime-release/manifest.json'
if ($LASTEXITCODE -ne 0) { throw '隔离 manifest 路径未被 Git ignore，拒绝 seed' }
if ((Get-WorktreeGitScalar $lock @('rev-parse','HEAD')) -ne $lock.source_head) { throw '既有 worktree HEAD 漂移' }

$manifestParent = Split-Path -Parent $lock.worktree_manifest
if (Test-Path -LiteralPath $manifestParent) {
  if (-not (Test-Path -LiteralPath $manifestParent -PathType Container)) { throw "runtime-release 不是目录：$manifestParent" }
} else {
  [System.IO.Directory]::CreateDirectory($manifestParent) | Out-Null
}
[System.IO.File]::Copy($script:MainManifest, [string]$lock.worktree_manifest, $false)
$isolatedManifestBefore = Get-Sha256 $lock.worktree_manifest
if ($isolatedManifestBefore -ne $script:ProtectedSpecs.main_manifest.sha256) { throw "seed manifest SHA 不符：$isolatedManifestBefore" }
if ((Get-Item -LiteralPath $script:MainManifest).Length -ne (Get-Item -LiteralPath $lock.worktree_manifest).Length) { throw 'seed manifest 字节数不符' }

$packagePath = Join-Path $lock.worktree 'VideoAutoCutDesktop\package.json'
$packageLockPath = Join-Path $lock.worktree 'VideoAutoCutDesktop\package-lock.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8 | ConvertFrom-Json
if ($package.scripts.'release:pack:runtime' -ne 'npm run build:scripts && node dist-scripts/pack-release.js --runtime') { throw '隔离 package pack script 不符' }
$toolPaths = @(Get-WorktreeGitLines $lock @('ls-tree','-r','--name-only','HEAD','--','VideoAutoCut/tools'))
if ($toolPaths.Count -ne 157) { throw "隔离 tracked tools 不是 157：$($toolPaths.Count)" }
$scriptCardFields = Join-Path $lock.worktree 'VideoAutoCut\tools\script_card_fields.py'
$scriptCardFieldsSha = Get-Sha256 $scriptCardFields
if ($scriptCardFieldsSha -ne 'ed9fcc788e7c8ef81ec3e23dd2bd45e09e55271106f3024c18a31e5ec8e77c57') { throw "script_card_fields SHA 不符：$scriptCardFieldsSha" }

Assert-IsolatedWorktree $lock 'finalize-worktree-complete'
Assert-MainLocked $lock 'finalize-worktree-exit'
$receipt = [ordered]@{
  source_head=[string]$lock.source_head
  worktree=[string]$lock.worktree
  worktree_head=Get-WorktreeGitScalar $lock @('rev-parse','HEAD')
  detached=$true
  resumed_after_prepare_harness_stop=$true
  original_10_log=(Join-Path $script:AuditRoot 'worktree-add.log')
  committed_package_only=$true
  package_json_sha256=Get-Sha256 $packagePath
  package_lock_sha256=Get-Sha256 $packageLockPath
  desktop_node_modules=[ordered]@{ strategy='junction_read_only'; source=$mainNodeModules; target=$worktreeNodeModules }
  tool_node_modules='absent_before_install_physical_isolated_only'
  tracked_tools_count=$toolPaths.Count
  script_card_fields_sha256=$scriptCardFieldsSha
  isolated_manifest_seed=[ordered]@{ source=$script:MainManifest; target=[string]$lock.worktree_manifest; gitignored=$true; bytes=[int64](Get-Item -LiteralPath $lock.worktree_manifest).Length; sha256=$isolatedManifestBefore }
}
Write-Json (Join-Path $script:AuditRoot 'worktree-created.json') $receipt
$state = [ordered]@{
  source_head=[string]$lock.source_head
  worktree=[string]$lock.worktree
  head_create=[string]$lock.source_head
  isolated_manifest_before_sha256=$isolatedManifestBefore
  worktree_complete=$true
  pack_complete=$false
  verify_complete=$false
  hashes_complete=$false
}
Save-State $state
Write-Output 'WORKTREE PREP PASS：复核既有 clean worktree，按原字节 seed gitignored manifest；下一阶段运行 20。'
