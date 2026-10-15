param()

. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')

$lock = Read-SourceLock
Assert-MainLocked $lock 'create-worktree-entry'
$statePath = Get-StatePath
if (Test-Path -LiteralPath $statePath) { throw "状态已存在，拒绝重跑：$statePath" }
if (Test-Path -LiteralPath $lock.worktree) { throw "worktree 目标已存在：$($lock.worktree)" }
if (Test-Path -LiteralPath $lock.worktree_zip) { throw "pkg5 目标已存在：$($lock.worktree_zip)" }

$mainNodeModules = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\node_modules'
if (-not (Test-Path -LiteralPath $mainNodeModules -PathType Container)) { throw "主 Desktop node_modules 不存在：$mainNodeModules" }

$gitLog = Join-Path $script:AuditRoot 'worktree-add.log'
Invoke-LoggedNative -FilePath (Get-Command git -ErrorAction Stop).Source -ArgumentList @(
  '-C', $script:RepoRoot, 'worktree', 'add', '--detach', [string]$lock.worktree, [string]$lock.source_head
) -LogPath $gitLog -Label 'create isolated worktree' -WorkingDirectory $script:RepoRoot | Out-Null

# 失败时保留部分 worktree 给 root 审查；本脚本没有清理路径。
Assert-IsolatedWorktree $lock 'after-worktree-add'
$worktreeNodeModules = Join-Path $lock.worktree 'VideoAutoCutDesktop\node_modules'
if (Test-Path -LiteralPath $worktreeNodeModules) { throw "隔离 Desktop node_modules 已存在：$worktreeNodeModules" }
New-Item -ItemType Junction -Path $worktreeNodeModules -Target $mainNodeModules | Out-Null
$junction = Get-Item -LiteralPath $worktreeNodeModules -Force
if (($junction.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'Desktop node_modules 未创建为 junction' }
$junctionTargets = @($junction.Target)
if ($junctionTargets.Count -ne 1 -or -not [string]::Equals([System.IO.Path]::GetFullPath([string]$junctionTargets[0]), [System.IO.Path]::GetFullPath($mainNodeModules), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Desktop node_modules junction 指向错误'
}

$piModules = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\pi\node_modules'
$hfModules = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\hyperframes\node_modules'
Assert-PhysicalDirectoryIfPresent $piModules
Assert-PhysicalDirectoryIfPresent $hfModules
if (Test-Path -LiteralPath $lock.worktree_zip) { throw 'create 阶段意外出现 pkg5' }
if (-not (Test-Path -LiteralPath $lock.worktree_manifest -PathType Leaf)) { throw '源提交中的隔离 manifest 缺失' }
$isolatedManifestBefore = Get-Sha256 $lock.worktree_manifest
if ($isolatedManifestBefore -ne $script:ProtectedSpecs.main_manifest.sha256) { throw "源提交 manifest SHA 不符：$isolatedManifestBefore" }

$packagePath = Join-Path $lock.worktree 'VideoAutoCutDesktop\package.json'
$packageLockPath = Join-Path $lock.worktree 'VideoAutoCutDesktop\package-lock.json'
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8 | ConvertFrom-Json
if ($package.scripts.'release:pack:runtime' -ne 'npm run build:scripts && node dist-scripts/pack-release.js --runtime') { throw '隔离 package pack script 不符' }
$toolPaths = @(Get-WorktreeGitLines $lock @('ls-tree', '-r', '--name-only', 'HEAD', '--', 'VideoAutoCut/tools'))
if ($toolPaths.Count -ne 157) { throw "隔离 tracked tools 不是 157：$($toolPaths.Count)" }
Assert-IsolatedWorktree $lock 'create-worktree-complete'
Assert-MainLocked $lock 'create-worktree-exit'

$receipt = [ordered]@{
  source_head = [string]$lock.source_head
  worktree = [string]$lock.worktree
  worktree_head = Get-WorktreeGitScalar $lock @('rev-parse', 'HEAD')
  detached = $true
  committed_package_only = $true
  package_json_sha256 = Get-Sha256 $packagePath
  package_lock_sha256 = Get-Sha256 $packageLockPath
  desktop_node_modules = [ordered]@{ strategy='junction_read_only'; source=$mainNodeModules; target=$worktreeNodeModules }
  tool_node_modules = 'physical_isolated_only'
  tracked_tools_count = $toolPaths.Count
  isolated_manifest_before_sha256 = $isolatedManifestBefore
}
Write-Json (Join-Path $script:AuditRoot 'worktree-created.json') $receipt
$state = [ordered]@{
  source_head = [string]$lock.source_head
  worktree = [string]$lock.worktree
  head_create = [string]$lock.source_head
  isolated_manifest_before_sha256 = $isolatedManifestBefore
  worktree_complete = $true
  pack_complete = $false
  verify_complete = $false
  hashes_complete = $false
}
Save-State $state
Write-Output 'WORKTREE PASS：只创建隔离 worktree 与 Desktop node_modules 只读复用 junction；下一阶段单独运行 20-install-pack-isolated.ps1。'
