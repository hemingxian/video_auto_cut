param()

. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')

$lock = Read-SourceLock
$state = Read-State
if ($state.worktree_complete -ne $true -or $state.pack_complete -eq $true) { throw 'worktree 阶段未完成或 pack 已完成' }
if ($state.source_head -ne $lock.source_head -or $state.head_create -ne $lock.source_head) { throw 'state/source lock 不一致' }
Assert-MainLocked $lock 'install-pack-entry'
Assert-IsolatedWorktree $lock 'install-pack-entry'
if (Test-Path -LiteralPath $lock.worktree_zip) { throw "拒绝覆盖 pkg5：$($lock.worktree_zip)" }
if ((Get-Sha256 $lock.worktree_manifest) -ne $state.isolated_manifest_before_sha256) { throw 'pack 前隔离 manifest 与 create 收据不符' }

$piRoot = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\pi'
$hfRoot = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\hyperframes'
$piModules = Join-Path $piRoot 'node_modules'
$hfModules = Join-Path $hfRoot 'node_modules'
Assert-PhysicalDirectoryIfPresent $piModules
Assert-PhysicalDirectoryIfPresent $hfModules
$probeRecords = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\records\_probe_w6.txt'
$probeCache = Join-Path $hfModules '.cache\_probe_w6.txt'
$recordsDir = Split-Path -Parent $probeRecords
$cacheDir = Split-Path -Parent $probeCache
$recordsDirExisted = Test-Path -LiteralPath $recordsDir -PathType Container
$cacheDirExisted = Test-Path -LiteralPath $cacheDir -PathType Container
$recordsSha = $null
$cacheSha = $null
$recordsRecreated = $false
$cacheRecreated = $false
$cleanup = [ordered]@{ records_probe='not_created'; cache_probe='not_created'; records_dir_initially_existed=[bool]$recordsDirExisted; cache_dir_initially_existed=[bool]$cacheDirExisted }
$processTemp = Join-Path $script:AuditRoot 'process-temp'
$expectedTemp = [System.IO.Path]::GetFullPath((Join-Path $script:AuditRoot 'process-temp'))
$actualTemp = [System.IO.Path]::GetFullPath($processTemp)
if (-not [string]::Equals($actualTemp, $expectedTemp, [System.StringComparison]::OrdinalIgnoreCase)) { throw '隔离 TEMP 路径不符' }
if (Test-Path -LiteralPath $processTemp) { throw "隔离 TEMP 已存在，拒绝复用：$processTemp" }
[System.IO.Directory]::CreateDirectory($processTemp) | Out-Null
$env:TEMP = $processTemp
$env:TMP = $processTemp
Write-Json (Join-Path $script:AuditRoot 'process-temp.json') ([ordered]@{
  temp=$processTemp
  tmp=$processTemp
  under_audit=$actualTemp.StartsWith(([System.IO.Path]::GetFullPath($script:AuditRoot).TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)
  existed_before=$false
  purpose='Confine pack-runtime runtime-stage-PID creation and cleanup to this W6 audit root.'
})

function Ensure-OwnedProbe([string]$Path, [string]$Expected, [string]$InitialSha, [ref]$Recreated) {
  if (-not (Test-Path -LiteralPath $Path)) {
    $sha = New-OwnedProbe $lock $Path $Expected
    if ($sha -ne $InitialSha) { throw "重建探针 SHA 不同：$Path" }
    $Recreated.Value = $true
    return $sha
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Sha256 $Path) -ne $InitialSha) {
    throw "安装后探针存在但不是自身固定内容，拒绝覆盖：$Path"
  }
  return $InitialSha
}

try {
  $recordsSha = New-OwnedProbe $lock $probeRecords $probeRecords
  $cacheSha = New-OwnedProbe $lock $probeCache $probeCache
  $piAgentDir = Join-Path $script:AuditRoot 'pi-coding-agent-empty'
  if (Test-Path -LiteralPath $piAgentDir) {
    if (@(Get-ChildItem -LiteralPath $piAgentDir -Force).Count -ne 0) { throw 'PI_CODING_AGENT_DIR 非空' }
  } else { [System.IO.Directory]::CreateDirectory($piAgentDir) | Out-Null }
  $env:PI_CODING_AGENT_DIR = $piAgentDir
  $python = (Get-Command python -ErrorAction Stop).Source
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $piInstaller = Join-Path $piRoot 'install_pi.py'
  $hfInstaller = Join-Path $hfRoot 'install_hyperframes.py'
  Invoke-LoggedNative -FilePath $python -ArgumentList @($piInstaller) -LogPath (Join-Path $script:AuditRoot 'pi-install.log') -Label 'isolated Pi install' -WorkingDirectory $piRoot | Out-Null
  Invoke-LoggedNative -FilePath $python -ArgumentList @($piInstaller, '--check') -LogPath (Join-Path $script:AuditRoot 'pi-check.log') -Label 'isolated Pi check' -WorkingDirectory $piRoot | Out-Null
  Invoke-LoggedNative -FilePath $python -ArgumentList @($hfInstaller, '--runtime-root', $script:BaseRuntime) -LogPath (Join-Path $script:AuditRoot 'hyperframes-install.log') -Label 'isolated HyperFrames install' -WorkingDirectory $hfRoot | Out-Null
  Invoke-LoggedNative -FilePath $python -ArgumentList @($hfInstaller, '--check', '--runtime-root', $script:BaseRuntime) -LogPath (Join-Path $script:AuditRoot 'hyperframes-check.log') -Label 'isolated HyperFrames check' -WorkingDirectory $hfRoot | Out-Null
  Assert-PhysicalDirectoryIfPresent $piModules
  Assert-PhysicalDirectoryIfPresent $hfModules
  $recordsSha = Ensure-OwnedProbe $probeRecords $probeRecords $recordsSha ([ref]$recordsRecreated)
  $cacheSha = Ensure-OwnedProbe $probeCache $probeCache $cacheSha ([ref]$cacheRecreated)
  Assert-MainLocked $lock 'before-pack'
  Assert-IsolatedWorktree $lock 'before-pack'
  $head2 = Get-WorktreeGitScalar $lock @('rev-parse', 'HEAD')
  if ($head2 -ne $lock.source_head) { throw 'pack 前 worktree HEAD 漂移' }
  Write-Json (Join-Path $script:AuditRoot 'probe-before-pack.json') ([ordered]@{
    records=[ordered]@{ path=$probeRecords; sha256=$recordsSha; recreated_after_install=[bool]$recordsRecreated }
    cache=[ordered]@{ path=$probeCache; sha256=$cacheSha; recreated_after_install=[bool]$cacheRecreated }
    reason='npm ci may delete tool node_modules; identical fixed probes are recreated only when absent so both exclusion layers are exercised'
    head_before_pack=$head2
  })
  $env:VIDEOAUTO_RUNTIME_VERSION = $script:RuntimeVersion
  $env:VIDEOAUTO_RUNTIME_BASE_ROOT = $script:BaseRuntime
  Invoke-LoggedNative -FilePath $npm -ArgumentList @('run', 'release:pack:runtime') -LogPath (Join-Path $script:AuditRoot 'pack-runtime.log') -Label 'isolated runtime pkg5 pack' -WorkingDirectory (Join-Path $lock.worktree 'VideoAutoCutDesktop') | Out-Null
  $artifact = Assert-IsolatedManifestMatchesArtifact $lock
  if ($artifact.manifest_sha256 -eq $state.isolated_manifest_before_sha256) { throw 'pack 后隔离 manifest 未变化' }
  $repoEngine = Join-Path $lock.worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe'
  $engineSha = Get-Sha256 $repoEngine
  if ($engineSha -ne 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf') { throw "隔离引擎 SHA 不符：$engineSha" }
  Assert-MainLocked $lock 'after-pack'
  Assert-IsolatedWorktree $lock 'after-pack' $true
  Write-Json (Join-Path $script:AuditRoot 'pack-artifact-preverify.json') $artifact
  Write-Json (Join-Path $script:AuditRoot 'engine-sha-after-pack.json') ([ordered]@{ expected='be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'; isolated_repo_engine=$engineSha; path=$repoEngine })
  Set-StateProperty $state 'head_before_pack' $head2
  Set-StateProperty $state 'pack_zip_sha256' $artifact.sha256
  Set-StateProperty $state 'pack_complete' $true
  Save-State $state
  Write-Output 'PACK PASS：隔离 pkg5 已生成；下一阶段单独运行 30-verify-isolated.ps1。'
} finally {
  $cleanupError = $null
  try {
    if ($null -ne $recordsSha) { $cleanup.records_probe = Remove-OwnedProbe $lock $probeRecords $probeRecords $recordsSha }
    if ($null -ne $cacheSha) { $cleanup.cache_probe = Remove-OwnedProbe $lock $probeCache $probeCache $cacheSha }
    Remove-OwnedEmptyDirectory $lock $recordsDir $recordsDir (-not $recordsDirExisted)
    Remove-OwnedEmptyDirectory $lock $cacheDir $cacheDir (-not $cacheDirExisted)
  } catch { $cleanupError = $_; $cleanup['cleanup_error'] = $_.Exception.Message }
  Write-Json (Join-Path $script:AuditRoot 'probe-cleanup.json') $cleanup
  if ($null -ne $cleanupError) { throw $cleanupError }
}
