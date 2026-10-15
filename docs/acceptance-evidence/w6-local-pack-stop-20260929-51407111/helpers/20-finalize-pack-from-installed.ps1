param()

. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')

$lock = Read-SourceLock
$state = Read-State
if ($state.worktree_complete -ne $true -or $state.pack_complete -eq $true) { throw '状态不允许从已安装现场继续 pack' }
if ($state.source_head -ne $lock.source_head -or $state.head_create -ne $lock.source_head) { throw 'state/source lock 不一致' }
Assert-MainLocked $lock 'resume-pack-entry'
Assert-IsolatedWorktree $lock 'resume-pack-entry'
if (Test-Path -LiteralPath $lock.worktree_zip) { throw "pkg5 已存在，拒绝 pack：$($lock.worktree_zip)" }
if ((Get-Sha256 $lock.worktree_manifest) -ne $state.isolated_manifest_before_sha256) { throw 'resume pack 前 manifest 不是 seed SHA' }

$requiredLogs = @('pi-install.log','pi-check.log','hyperframes-install.log','hyperframes-check.log')
foreach ($name in $requiredLogs) {
  $path = Join-Path $script:AuditRoot $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0) { throw "缺少成功安装阶段日志：$name" }
}
if (-not (Select-String -LiteralPath (Join-Path $script:AuditRoot 'pi-check.log') -SimpleMatch '[install_pi] ✓ version       0.85.1' -Quiet)) { throw 'Pi check 日志缺少成功版本行' }
if (-not (Select-String -LiteralPath (Join-Path $script:AuditRoot 'hyperframes-check.log') -SimpleMatch '[install_hyperframes] ✓ hyperframes   0.7.3' -Quiet)) { throw 'HyperFrames check 日志缺少成功版本行' }

$piRoot = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\pi'
$hfRoot = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\hyperframes'
$piModules = Join-Path $piRoot 'node_modules'
$hfModules = Join-Path $hfRoot 'node_modules'
foreach ($path in @($piModules,$hfModules)) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "已安装物理依赖缺失：$path" }
  Assert-PhysicalDirectoryIfPresent $path
}

$processTemp = Join-Path $script:AuditRoot 'process-temp'
$processTempReceipt = Join-Path $script:AuditRoot 'process-temp.json'
if (-not (Test-Path -LiteralPath $processTemp -PathType Container) -or -not (Test-Path -LiteralPath $processTempReceipt -PathType Leaf)) { throw '本轮 owned process TEMP 或收据缺失' }
$tempInfo = Get-Content -LiteralPath $processTempReceipt -Raw -Encoding utf8 | ConvertFrom-Json
if ($tempInfo.temp -ne $processTemp -or $tempInfo.tmp -ne $processTemp -or $tempInfo.under_audit -ne $true -or $tempInfo.existed_before -ne $false) { throw 'process TEMP 收据不符' }
if (@(Get-ChildItem -LiteralPath $processTemp -Directory -Filter 'VideoAutoCut-runtime-stage-*' -Force).Count -ne 0) { throw 'process TEMP 已有 runtime stage，不能证明尚未 pack' }
if (Test-Path -LiteralPath (Join-Path $script:AuditRoot 'pack-runtime.log')) { throw 'pack 日志已存在，拒绝继续' }
$env:TEMP = $processTemp
$env:TMP = $processTemp

$python = (Get-Command python -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$piInstaller = Join-Path $piRoot 'install_pi.py'
$hfInstaller = Join-Path $hfRoot 'install_hyperframes.py'
$piAgentDir = Join-Path $script:AuditRoot 'pi-coding-agent-empty'
if (-not (Test-Path -LiteralPath $piAgentDir -PathType Container) -or @(Get-ChildItem -LiteralPath $piAgentDir -Force).Count -ne 0) { throw 'PI_CODING_AGENT_DIR 缺失或非空' }
$env:PI_CODING_AGENT_DIR = $piAgentDir
Invoke-LoggedNative -FilePath $python -ArgumentList @($piInstaller,'--check') -LogPath (Join-Path $script:AuditRoot 'resume-pi-check.log') -Label 'resume Pi check' -WorkingDirectory $piRoot | Out-Null
Invoke-LoggedNative -FilePath $python -ArgumentList @($hfInstaller,'--check','--runtime-root',$script:BaseRuntime) -LogPath (Join-Path $script:AuditRoot 'resume-hyperframes-check.log') -Label 'resume HyperFrames check' -WorkingDirectory $hfRoot | Out-Null

$probeRecords = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\records\_probe_w6.txt'
$probeCache = Join-Path $hfModules '.cache\_probe_w6.txt'
$recordsDir = Split-Path -Parent $probeRecords
$cacheDir = Split-Path -Parent $probeCache
$recordsDirExisted = Test-Path -LiteralPath $recordsDir -PathType Container
$cacheDirExisted = Test-Path -LiteralPath $cacheDir -PathType Container
$recordsSha = $null
$cacheSha = $null
$cleanup = [ordered]@{ records_probe='not_created'; cache_probe='not_created'; records_dir_initially_existed=[bool]$recordsDirExisted; cache_dir_initially_existed=[bool]$cacheDirExisted }
try {
  $recordsSha = New-OwnedProbe $lock $probeRecords $probeRecords
  $cacheSha = New-OwnedProbe $lock $probeCache $probeCache
  Assert-MainLocked $lock 'resume-before-pack'
  Assert-IsolatedWorktree $lock 'resume-before-pack' $false $true
  $head2 = Get-WorktreeGitScalar $lock @('rev-parse','HEAD')
  if ($head2 -ne $lock.source_head) { throw 'pack 前 worktree HEAD 漂移' }
  Write-Json (Join-Path $script:AuditRoot 'probe-before-pack-resume.json') ([ordered]@{
    records=[ordered]@{ path=$probeRecords; sha256=$recordsSha; recreated_after_failed_prepare=$true }
    cache=[ordered]@{ path=$probeCache; sha256=$cacheSha; recreated_after_failed_prepare=$true }
    allowed_untracked=@('?? VideoAutoCut/tools/material_gen/records/_probe_w6.txt')
    head_before_pack=$head2
  })
  $env:VIDEOAUTO_RUNTIME_VERSION = $script:RuntimeVersion
  $env:VIDEOAUTO_RUNTIME_BASE_ROOT = $script:BaseRuntime
  Invoke-LoggedNative -FilePath $npm -ArgumentList @('run','release:pack:runtime') -LogPath (Join-Path $script:AuditRoot 'pack-runtime.log') -Label 'isolated runtime pkg5 unique pack' -WorkingDirectory (Join-Path $lock.worktree 'VideoAutoCutDesktop') | Out-Null
  $artifact = Assert-IsolatedManifestMatchesArtifact $lock
  if ($artifact.manifest_sha256 -eq $state.isolated_manifest_before_sha256) { throw 'pack 后隔离 manifest 未变化' }
  $repoEngine = Join-Path $lock.worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe'
  $engineSha = Get-Sha256 $repoEngine
  if ($engineSha -ne 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf') { throw "隔离引擎 SHA 不符：$engineSha" }
  Assert-MainLocked $lock 'resume-after-pack'
  Assert-IsolatedWorktree $lock 'resume-after-pack' $true $true
  Write-Json (Join-Path $script:AuditRoot 'pack-artifact-preverify.json') $artifact
  Write-Json (Join-Path $script:AuditRoot 'engine-sha-after-pack.json') ([ordered]@{ expected='be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'; isolated_repo_engine=$engineSha; path=$repoEngine })
  Set-StateProperty $state 'head_before_pack' $head2
  Set-StateProperty $state 'pack_zip_sha256' $artifact.sha256
  Set-StateProperty $state 'pack_complete' $true
  Set-StateProperty $state 'resumed_after_prepare_harness_stop' $true
  Save-State $state
  Write-Output 'PACK PASS：已安装现场完成唯一正式 pkg5 pack；下一阶段运行 30。'
} finally {
  $cleanupError = $null
  try {
    if ($null -ne $recordsSha) { $cleanup.records_probe = Remove-OwnedProbe $lock $probeRecords $probeRecords $recordsSha }
    if ($null -ne $cacheSha) { $cleanup.cache_probe = Remove-OwnedProbe $lock $probeCache $probeCache $cacheSha }
    Remove-OwnedEmptyDirectory $lock $recordsDir $recordsDir (-not $recordsDirExisted)
    Remove-OwnedEmptyDirectory $lock $cacheDir $cacheDir (-not $cacheDirExisted)
  } catch { $cleanupError = $_; $cleanup['cleanup_error'] = $_.Exception.Message }
  Write-Json (Join-Path $script:AuditRoot 'probe-cleanup-resume.json') $cleanup
  if ($null -ne $cleanupError) { throw $cleanupError }
}
