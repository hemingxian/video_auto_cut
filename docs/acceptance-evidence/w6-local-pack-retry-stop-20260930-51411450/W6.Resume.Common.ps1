Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = 'D:\autocut\video-auto-cut'
$script:AuditRoot = 'D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\w6-51411450-one-retry-20260930'
$script:Branch = 'feature/material-agent-select'
$script:Master = '60b3e3d95ef0cb0fa721d02709aa8f3f8be8cc9c'
$script:MainEvidenceHead = 'dcab57fb7426a546e1a09ac23e3e1ca1e3a9c5f5'
$script:SourceHead = '4c6fb40ff7371e73a0d0daa4c9ef0606610afc21'
$script:RuntimeProductionAnchor = '311d5e5b02bbf8610036cf81bea66b736a92621a'
$script:RuntimeVersion = '0.5.15-agent-trial-pkg5'
$script:BaseRuntime = 'D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.14\VideoAutoCut'
$script:MainManifest = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\runtime-release\manifest.json'
$script:SourceLockPath = Join-Path $script:AuditRoot 'SOURCE-LOCK.json'
$script:MaterialOracle = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\node_modules\.tmp\agent-acceptance-batch4-20260917-3d5f2e5\material_manifest.json'

$script:ExpectedBlobs = [ordered]@{
  'VideoAutoCutDesktop/scripts/pack-runtime.ts' = '57200406cba02428ef106cdfd8afe069011332cf'
  'VideoAutoCutDesktop/scripts/pack-release.ts' = '07fee2b205724db2a7a1b41ddd3a9e5e3146d423'
  'docs/acceptance-tools/check_pkg_contents.py' = '54c4611b0323c7781b3ce29bb82235d96c5f0416'
}

$script:ProtectedSpecs = [ordered]@{
  package_json = [ordered]@{ path = (Join-Path $script:RepoRoot 'VideoAutoCutDesktop\package.json'); sha256 = '8c89f426c9c350b3388245a4ef077653d31cb8f155b7085ef4d59286dc0c3d91' }
  package_lock = [ordered]@{ path = (Join-Path $script:RepoRoot 'VideoAutoCutDesktop\package-lock.json'); sha256 = '7e9958728343da5c85f96188c11f6e69aee5f7b3918ec23c89a7196abf398ec8' }
  main_manifest = [ordered]@{ path = $script:MainManifest; sha256 = 'b92c9477703b91d503974881c103b0b35cb8878f819691caa28cdae764f99942' }
  release_upload_config = [ordered]@{ path = (Join-Path $script:RepoRoot 'VideoAutoCutDesktop\release-upload.local.json'); sha256 = 'd3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c' }
  production_app_env = [ordered]@{ path = 'D:\Video Edit\VideoAutoCut\config\app.env'; sha256 = 'b9d6ecaf70da6bc559429efccbcc616356f82878cd79e97428c9e1a19b875cab' }
  user_pi_models = [ordered]@{ path = 'C:\Users\evstm\.pi\agent\models.json'; sha256 = 'c42af349bd0897e18b086c7f799442f7e08f2d3adb8639dba38fb08290dc822a' }
}

function Get-Sha256([string]$LiteralPath) {
  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { throw "缺少文件：$LiteralPath" }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Write-Utf8NoBom([string]$LiteralPath, [string]$Text) {
  $parent = Split-Path -Parent $LiteralPath
  if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
  [System.IO.File]::WriteAllText($LiteralPath, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Write-Json([string]$LiteralPath, $Value) {
  if (Test-Path -LiteralPath $LiteralPath) { throw "拒绝覆盖已有收据：$LiteralPath" }
  Write-Utf8NoBom $LiteralPath (($Value | ConvertTo-Json -Depth 30) + "`n")
}

function Get-GitLines([string[]]$Arguments) {
  $lines = @(& git -C $script:RepoRoot @Arguments 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE" }
  return $lines
}

function Get-GitScalar([string[]]$Arguments) {
  $lines = @(Get-GitLines $Arguments)
  if ($lines.Count -ne 1) { throw "git 输出不为一行：$($Arguments -join ' ')" }
  return $lines[0].Trim()
}

function Get-ProtectedSnapshot {
  $items = @()
  foreach ($entry in $script:ProtectedSpecs.GetEnumerator()) {
    $file = Get-Item -LiteralPath $entry.Value.path -Force
    $sha = Get-Sha256 $entry.Value.path
    if ($sha -ne $entry.Value.sha256) { throw "保护对象 SHA 不符：$($entry.Value.path)" }
    $items += [ordered]@{ name = $entry.Key; path = $entry.Value.path; bytes = [int64]$file.Length; sha256 = $sha }
  }
  return $items
}

function Assert-MainWorkingTree {
  $expected = @(' M VideoAutoCutDesktop/package-lock.json', ' M VideoAutoCutDesktop/package.json')
  $actual = @(Get-GitLines @('status', '--porcelain=v1'))
  Assert-ExactLines $expected $actual '主工作区状态'
}

function Assert-FullSha([string]$Value) {
  if ($Value -cnotmatch '^[0-9a-f]{40}$') { throw "不是小写完整 Git SHA：$Value" }
}

function Assert-ExactLines([string[]]$Expected, [string[]]$Actual, [string]$Label) {
  [string[]]$left = @()
  [string[]]$right = @()
  if ($null -ne $Expected) { $left = @($Expected) }
  if ($null -ne $Actual) { $right = @($Actual) }
  if ($left.Count -ne $right.Count) { throw "$Label 数量不符：expected=$($left.Count) actual=$($right.Count)" }
  for ($index = 0; $index -lt $left.Count; $index++) {
    if ($left[$index] -cne $right[$index]) { throw "$Label 第 $($index + 1) 行不符：expected=$($left[$index]) actual=$($right[$index])" }
  }
}

function Read-SourceLock {
  if (-not (Test-Path -LiteralPath $script:SourceLockPath -PathType Leaf)) { throw "缺少 SOURCE-LOCK：$($script:SourceLockPath)" }
  $lock = Get-Content -LiteralPath $script:SourceLockPath -Raw -Encoding utf8 | ConvertFrom-Json
  Assert-FullSha ([string]$lock.source_head)
  if ($lock.authorized_instruction -ne 51411450 -or $lock.source_head_full -ne $true) { throw 'SOURCE-LOCK 授权字段不符' }
  if ($lock.branch -ne $script:Branch -or $lock.master -ne $script:Master -or $lock.runtime_version -ne $script:RuntimeVersion -or $lock.runtime_base -ne $script:BaseRuntime) { throw 'SOURCE-LOCK 固定输入不符' }
  $expectedWorktree = "D:\autocut\video-auto-cut-w6-51407111-$(([string]$lock.source_head).Substring(0,12))"
  $expectedZip = Join-Path $expectedWorktree "VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-$($script:RuntimeVersion).zip"
  $expectedManifest = Join-Path $expectedWorktree 'VideoAutoCutDesktop\runtime-release\manifest.json'
  if ($lock.worktree -ne $expectedWorktree -or $lock.worktree_zip -ne $expectedZip -or $lock.worktree_manifest -ne $expectedManifest) { throw 'SOURCE-LOCK 隔离路径不符' }
  if ($lock.main_manifest -ne $script:MainManifest) { throw 'SOURCE-LOCK 主 manifest 路径不符' }
  if ($lock.main_manifest_sha256_must_remain -ne $script:ProtectedSpecs.main_manifest.sha256) { throw 'SOURCE-LOCK 主 manifest SHA 不符' }
  if ($lock.committed_package_only -ne $true -or $lock.copy_user_dirty_package_files -ne $false) { throw 'SOURCE-LOCK package 隔离策略不符' }
  return $lock
}

function Assert-MainLocked($Lock, [string]$Stage) {
  $head = Get-GitScalar @('rev-parse', 'HEAD')
  if ($head -ne $script:MainEvidenceHead) { throw "[$Stage] 主 HEAD 漂移：预期=$($script:MainEvidenceHead) 当前=$head" }
  if ((Get-GitScalar @('branch', '--show-current')) -ne $script:Branch) { throw "[$Stage] 主分支漂移" }
  if ((Get-GitScalar @('rev-parse', 'master')) -ne $script:Master) { throw "[$Stage] master 漂移" }
  Assert-MainWorkingTree
  Get-ProtectedSnapshot | Out-Null
}

function Get-WorktreeGitLines($Lock, [string[]]$Arguments) {
  $lines = @(& git -C $Lock.worktree @Arguments 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { throw "worktree git $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE" }
  return $lines
}

function Get-WorktreeGitScalar($Lock, [string[]]$Arguments) {
  $lines = @(Get-WorktreeGitLines $Lock $Arguments)
  if ($lines.Count -ne 1) { throw 'worktree git 输出不为一行' }
  return $lines[0].Trim()
}

function Assert-IsolatedWorktree($Lock, [string]$Stage, [bool]$AllowGeneratedManifest = $false, [bool]$AllowOwnedProbes = $false) {
  if (-not (Test-Path -LiteralPath $Lock.worktree -PathType Container)) { throw "[$Stage] 隔离 worktree 不存在：$($Lock.worktree)" }
  $expectedPrefix = 'D:\autocut\video-auto-cut-w6-51407111-'
  $actual = [System.IO.Path]::GetFullPath([string]$Lock.worktree)
  if (-not $actual.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "[$Stage] worktree 不在固定前缀：$actual" }
  $head = Get-WorktreeGitScalar $Lock @('rev-parse', 'HEAD')
  if ($head -ne $Lock.source_head) { throw "[$Stage] worktree HEAD 漂移：$head" }
  $status = @(Get-WorktreeGitLines $Lock @('status', '--porcelain=v1', '--untracked-files=all'))
  # This continuation creates no records/cache probes. The manifest, physical
  # dependencies, and temporary release config are gitignored; every visible
  # tracked or untracked path remains a hard failure.
  Assert-ExactLines @() $status "[$Stage] worktree 状态"
}

function Assert-PhysicalDirectoryIfPresent([string]$LiteralPath) {
  if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (-not $item.PSIsContainer) { throw "路径不是目录：$LiteralPath" }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "工具依赖目录不得为 reparse point：$LiteralPath" }
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  if (Test-Path -LiteralPath $LogPath) { throw "拒绝覆盖日志：$LogPath" }
  $rc = $null
  $oldPreference = $ErrorActionPreference
  $nativePreferenceExists = Test-Path variable:PSNativeCommandUseErrorActionPreference
  if ($nativePreferenceExists) { $oldNativePreference = $PSNativeCommandUseErrorActionPreference }
  Push-Location $WorkingDirectory
  try {
    $ErrorActionPreference = 'Continue'
    if ($nativePreferenceExists) { $PSNativeCommandUseErrorActionPreference = $false }
    & $FilePath @ArgumentList 2>&1 | Tee-Object -FilePath $LogPath
    $rc = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
    if ($nativePreferenceExists) { $PSNativeCommandUseErrorActionPreference = $oldNativePreference }
    Pop-Location
  }
  if ($null -eq $rc -or $rc -ne 0) { throw "$Label 失败，退出码 $rc；见 $LogPath" }
  return $rc
}

function Get-StatePath { return Join-Path $script:AuditRoot 'W6-ISOLATED-STATE.json' }

function Read-State {
  $path = Get-StatePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少状态：$path" }
  return Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json
}

function Save-State($State) {
  Write-Utf8NoBom (Get-StatePath) (($State | ConvertTo-Json -Depth 30) + "`n")
}

function Set-StateProperty($State, [string]$Name, $Value) {
  $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Assert-SafeExactWorktreePath($Lock, [string]$LiteralPath, [string]$ExpectedPath) {
  $actual = [System.IO.Path]::GetFullPath($LiteralPath)
  $expected = [System.IO.Path]::GetFullPath($ExpectedPath)
  if (-not [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)) { throw "非预期精确路径：$actual" }
  $prefix = [System.IO.Path]::GetFullPath([string]$Lock.worktree).TrimEnd('\') + '\'
  if (-not $actual.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "目标不在隔离 worktree：$actual" }
}

function Assert-NoReparseParents($Lock, [string]$LiteralPath) {
  $root = [System.IO.Path]::GetFullPath([string]$Lock.worktree).TrimEnd('\')
  $cursor = Split-Path -Parent ([System.IO.Path]::GetFullPath($LiteralPath))
  while ($cursor.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "探针父目录是 reparse point：$cursor" }
    }
    if ([string]::Equals($cursor, $root, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $next = Split-Path -Parent $cursor
    if ($next -eq $cursor) { break }
    $cursor = $next
  }
}

function New-OwnedProbe($Lock, [string]$LiteralPath, [string]$ExpectedPath) {
  Assert-SafeExactWorktreePath $Lock $LiteralPath $ExpectedPath
  Assert-NoReparseParents $Lock $LiteralPath
  if (Test-Path -LiteralPath $LiteralPath) { throw "探针已存在：$LiteralPath" }
  [System.IO.Directory]::CreateDirectory((Split-Path -Parent $LiteralPath)) | Out-Null
  [System.IO.File]::WriteAllText($LiteralPath, 'probe', [System.Text.UTF8Encoding]::new($false))
  return Get-Sha256 $LiteralPath
}

function Remove-OwnedProbe($Lock, [string]$LiteralPath, [string]$ExpectedPath, [string]$ExpectedSha) {
  Assert-SafeExactWorktreePath $Lock $LiteralPath $ExpectedPath
  if (-not (Test-Path -LiteralPath $LiteralPath)) { return 'already_absent' }
  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { throw "拒绝删除非普通探针文件：$LiteralPath" }
  Assert-NoReparseParents $Lock $LiteralPath
  if ((Get-Sha256 $LiteralPath) -ne $ExpectedSha) { throw "探针 SHA 变化，拒绝删除：$LiteralPath" }
  Remove-Item -LiteralPath $LiteralPath -Force
  return 'removed_owned_probe'
}

function Remove-OwnedEmptyDirectory($Lock, [string]$LiteralPath, [string]$ExpectedPath, [bool]$CreatedByScript) {
  if (-not $CreatedByScript -or -not (Test-Path -LiteralPath $LiteralPath -PathType Container)) { return }
  Assert-SafeExactWorktreePath $Lock $LiteralPath $ExpectedPath
  Assert-NoReparseParents $Lock (Join-Path $LiteralPath '_sentinel')
  if (@(Get-ChildItem -LiteralPath $LiteralPath -Force).Count -eq 0) { Remove-Item -LiteralPath $LiteralPath }
}

function Assert-IsolatedManifestMatchesArtifact($Lock) {
  if (-not (Test-Path -LiteralPath $Lock.worktree_zip -PathType Leaf)) { throw "缺少隔离 pkg5：$($Lock.worktree_zip)" }
  if (-not (Test-Path -LiteralPath $Lock.worktree_manifest -PathType Leaf)) { throw "缺少隔离 manifest：$($Lock.worktree_manifest)" }
  $manifest = Get-Content -LiteralPath $Lock.worktree_manifest -Raw -Encoding utf8 | ConvertFrom-Json
  $versions = @($manifest.versions)
  if ($manifest.latest -ne $script:RuntimeVersion -or $versions.Count -ne 1) { throw '隔离 manifest latest/versions 不符' }
  $item = $versions[0]
  $zip = Get-Item -LiteralPath $Lock.worktree_zip
  $sha = Get-Sha256 $Lock.worktree_zip
  $urlName = [System.IO.Path]::GetFileName(([uri]$item.url).AbsolutePath)
  if ($item.version -ne $script:RuntimeVersion -or $urlName -ne $zip.Name) { throw '隔离 manifest version/url filename 不符' }
  if ([string]$item.sha256 -ne $sha -or [int64]$item.size -ne [int64]$zip.Length) { throw '隔离 manifest SHA/size 与 zip 不符' }
  return [ordered]@{ latest=$manifest.latest; version=$item.version; url_filename=$urlName; zip_filename=$zip.Name; size=[int64]$zip.Length; sha256=$sha; manifest_sha256=(Get-Sha256 $Lock.worktree_manifest) }
}
