param()

. (Join-Path $PSScriptRoot 'W6.Resume.Common.ps1')

$worktree = 'D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737'
$zip = Join-Path $worktree "VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-$($script:RuntimeVersion).zip"
$manifest = Join-Path $worktree 'VideoAutoCutDesktop\runtime-release\manifest.json'
$sourceConfig = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\release-upload.local.json'
$targetConfig = Join-Path $worktree 'VideoAutoCutDesktop\release-upload.local.json'
$expectedConfigSha = 'd3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c'
$oldAudit = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\node_modules\.tmp\w6-51407111-isolated-pkg5-20260929-v2'
$oldStatePath = Join-Path $oldAudit 'W6-ISOLATED-STATE.json'
$oldPackLog = Join-Path $oldAudit 'pack-runtime.log'

foreach ($path in @($script:SourceLockPath,(Get-StatePath),(Join-Path $script:AuditRoot 'consume-once.json'),(Join-Path $script:AuditRoot 'pack-runtime-retry.log'),(Join-Path $script:AuditRoot 'config-copy-delete.json'))) {
  if (Test-Path -LiteralPath $path) { throw "fresh audit 输出已存在，拒绝执行：$path" }
}
if (Test-Path -LiteralPath $targetConfig) { throw '隔离配置目标原先必须不存在' }
if (Test-Path -LiteralPath $zip) { throw 'pkg5 已存在，拒绝消费 retry' }
if ((Get-Sha256 $sourceConfig) -ne $expectedConfigSha) { throw '主配置 SHA 不符' }
$sourceBytes = [int64](Get-Item -LiteralPath $sourceConfig).Length

$lock = [ordered]@{
  schema=2
  authorized_instruction=51411450
  source_head=$script:SourceHead
  source_head_full=$true
  branch=$script:Branch
  master=$script:Master
  runtime_version=$script:RuntimeVersion
  runtime_base=$script:BaseRuntime
  worktree=$worktree
  worktree_zip=$zip
  worktree_manifest=$manifest
  main_manifest=$script:MainManifest
  main_manifest_sha256_must_remain=$script:ProtectedSpecs.main_manifest.sha256
  committed_package_only=$true
  copy_user_dirty_package_files=$false
  continuation_from_comment=51407352
  one_retry_only=$true
}
Write-Json $script:SourceLockPath $lock
$lock = Read-SourceLock
Assert-MainLocked $lock 'retry-preflight-main'
Assert-IsolatedWorktree $lock 'retry-preflight-worktree'
if ((Get-WorktreeGitScalar $lock @('rev-parse','--abbrev-ref','HEAD')) -ne 'HEAD') { throw '隔离 worktree 不是 detached HEAD' }
if ((Get-WorktreeGitScalar $lock @('rev-parse','HEAD')) -ne $script:SourceHead) { throw '隔离 source HEAD 不符' }
if ((Get-Sha256 $manifest) -ne $script:ProtectedSpecs.main_manifest.sha256) { throw '隔离 manifest seed SHA 不符' }
$oldState = Get-Content -LiteralPath $oldStatePath -Raw -Encoding utf8 | ConvertFrom-Json
if ($oldState.source_head -ne $script:SourceHead -or $oldState.pack_complete -ne $false -or $oldState.verify_complete -ne $false -or $oldState.hashes_complete -ne $false) { throw '旧 v2 state 不允许续行' }
if ((Get-Sha256 $oldPackLog) -ne '91d1d51eb80906cc4578f8e192677bc298ac5550e864ee4dd075a330c8bb287e') { throw '旧首次 pack log SHA 不符' }
foreach ($dir in @(
  (Join-Path $worktree 'VideoAutoCut\tools\material_gen\pi\node_modules'),
  (Join-Path $worktree 'VideoAutoCut\tools\material_gen\hyperframes\node_modules')
)) {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "既有物理依赖缺失：$dir" }
  Assert-PhysicalDirectoryIfPresent $dir
}

$protectedBefore = @(Get-ProtectedSnapshot)
Write-Json (Join-Path $script:AuditRoot 'protected-main-before.json') $protectedBefore
Write-Json (Join-Path $script:AuditRoot 'preflight.json') ([ordered]@{
  instruction=51411450
  main_head=$script:MainEvidenceHead
  source_head=$script:SourceHead
  worktree_detached=$true
  worktree_status=@()
  old_formal_pack_calls=1
  old_formal_pack_exit=1
  retry_calls_before=0
  pkg_exists_before=$false
  source_config=[ordered]@{ path='VideoAutoCutDesktop/release-upload.local.json'; bytes=$sourceBytes; sha256=$expectedConfigSha; content_recorded=$false }
  dependencies_reinstalled=$false
  probes_created=$false
})

[System.IO.File]::Copy($sourceConfig, $targetConfig, $false)
if ((Get-Sha256 $targetConfig) -ne $expectedConfigSha -or (Get-Item -LiteralPath $targetConfig).Length -ne $sourceBytes) { throw '隔离配置副本 SHA/bytes 不符' }
& git -C $worktree check-ignore -q -- 'VideoAutoCutDesktop/release-upload.local.json'
if ($LASTEXITCODE -ne 0) { throw '隔离配置副本未被 Git ignore' }
Assert-IsolatedWorktree $lock 'after-config-copy-normal-status'
$ignoredLine = @(& git -C $worktree status --ignored --porcelain=v1 --untracked-files=all -- 'VideoAutoCutDesktop/release-upload.local.json')
if ($LASTEXITCODE -ne 0 -or $ignoredLine.Count -ne 1 -or [string]$ignoredLine[0] -ne '!! VideoAutoCutDesktop/release-upload.local.json') { throw '隔离配置 --ignored 可见性不符' }

$processTemp = Join-Path $script:AuditRoot 'process-temp'
if (Test-Path -LiteralPath $processTemp) { throw 'fresh process TEMP 已存在' }
[System.IO.Directory]::CreateDirectory($processTemp) | Out-Null
$piAgentDir = Join-Path $script:AuditRoot 'pi-coding-agent-empty'
[System.IO.Directory]::CreateDirectory($piAgentDir) | Out-Null
if (@(Get-ChildItem -LiteralPath $piAgentDir -Force).Count -ne 0) { throw 'fresh PI_CODING_AGENT_DIR 非空' }
$env:TEMP=$processTemp
$env:TMP=$processTemp
$env:VIDEOAUTO_RUNTIME_VERSION=$script:RuntimeVersion
$env:VIDEOAUTO_RUNTIME_BASE_ROOT=$script:BaseRuntime
$env:PI_CODING_AGENT_DIR=$piAgentDir
Write-Json (Join-Path $script:AuditRoot 'pack-environment.json') ([ordered]@{
  runtime_version=$script:RuntimeVersion
  runtime_base_root=$script:BaseRuntime
  process_temp=$processTemp
  pi_coding_agent_dir=$piAgentDir
  pi_coding_agent_dir_empty=$true
  values_set_explicitly_for_retry=$true
})
Write-Json (Join-Path $script:AuditRoot 'config-copied.json') ([ordered]@{
  source='VideoAutoCutDesktop/release-upload.local.json'
  target='isolated-worktree/VideoAutoCutDesktop/release-upload.local.json'
  bytes=$sourceBytes
  sha256=$expectedConfigSha
  same_bytes_and_sha=$true
  git_check_ignore=$true
  normal_status_unchanged=$true
  target_ignored_status='!!'
  content_recorded=$false
})

$consumePath = Join-Path $script:AuditRoot 'consume-once.json'
Write-Json $consumePath ([ordered]@{
  instruction=51411450
  consumed_at=(Get-Date).ToString('o')
  command='npm run release:pack:runtime'
  retry_ordinal=1
  retry_limit=1
  must_never_invoke_again=$true
})

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logPath = Join-Path $script:AuditRoot 'pack-runtime-retry.log'
$headBeforePack = Get-WorktreeGitScalar $lock @('rev-parse','HEAD')
if ($headBeforePack -ne $lock.source_head) { throw '正式调用前隔离 HEAD 不符' }
$rc=$null
$oldPreference=$ErrorActionPreference
$nativePreferenceExists=Test-Path variable:PSNativeCommandUseErrorActionPreference
if($nativePreferenceExists){$oldNativePreference=$PSNativeCommandUseErrorActionPreference}
$deleted=$false
try {
  Push-Location (Join-Path $worktree 'VideoAutoCutDesktop')
  try {
    $ErrorActionPreference='Continue'
    if($nativePreferenceExists){$PSNativeCommandUseErrorActionPreference=$false}
    & $npm @('run','release:pack:runtime') 2>&1 | Tee-Object -FilePath $logPath
    $rc=$LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference=$oldPreference
    if($nativePreferenceExists){$PSNativeCommandUseErrorActionPreference=$oldNativePreference}
  }
} finally {
  if ($null -ne $rc -and $rc -eq 0) {
    $actualTarget=[System.IO.Path]::GetFullPath($targetConfig)
    $expectedTarget=[System.IO.Path]::GetFullPath((Join-Path $worktree 'VideoAutoCutDesktop\release-upload.local.json'))
    if (-not [string]::Equals($actualTarget,$expectedTarget,[System.StringComparison]::OrdinalIgnoreCase)) { throw '配置删除目标路径不符' }
    if ((Get-Sha256 $targetConfig) -ne $expectedConfigSha -or (Get-Item -LiteralPath $targetConfig).Length -ne $sourceBytes) { throw '配置副本在删除前发生变化' }
    [System.IO.File]::Delete($targetConfig)
    $deleted = -not (Test-Path -LiteralPath $targetConfig)
  }
  Write-Json (Join-Path $script:AuditRoot 'config-copy-delete.json') ([ordered]@{
    pack_exit_code=$rc
    expected_sha256=$expectedConfigSha
    expected_bytes=$sourceBytes
    deleted_after_pack_success=$deleted
    target_absent_after_delete=(-not (Test-Path -LiteralPath $targetConfig))
    main_config_sha256_after=Get-Sha256 $sourceConfig
    config_content_recorded=$false
  })
}

if ($null -eq $rc -or $rc -ne 0) {
  Write-Json (Join-Path $script:AuditRoot 'STOP.json') ([ordered]@{ status='STOP_PACK_RETRY_FAILED_NO_FURTHER_RETRY'; exit_code=$rc; retry_calls=1; pkg_exists=(Test-Path -LiteralPath $zip); config_copy_left_in_worktree=(Test-Path -LiteralPath $targetConfig); investigation_performed=$false })
  throw "唯一 pack retry 失败，退出码 $rc；按 51411450 原样 STOP"
}
if (-not $deleted) { throw 'pack exit0 后配置副本未删除' }
Assert-IsolatedWorktree $lock 'after-pack-config-deleted'
$artifact = Assert-IsolatedManifestMatchesArtifact $lock
$repoEngine=Join-Path $worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe'
$engineSha=Get-Sha256 $repoEngine
if($engineSha -ne 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'){throw "engine SHA 不符：$engineSha"}
Assert-MainLocked $lock 'retry-pack-exit'
$state=[ordered]@{source_head=$script:SourceHead;main_evidence_head=$script:MainEvidenceHead;worktree=$worktree;head_create=$script:SourceHead;head_before_pack=$headBeforePack;isolated_manifest_before_sha256=$script:ProtectedSpecs.main_manifest.sha256;pack_zip_sha256=$artifact.sha256;pack_retry_calls=1;worktree_complete=$true;pack_complete=$true;config_copy_deleted=$true;credential_scan_complete=$false;verify_complete=$false;hashes_complete=$false;cleanup_started=$false}
Save-State $state
Write-Json (Join-Path $script:AuditRoot 'pack-artifact-preverify.json') $artifact
Write-Json (Join-Path $script:AuditRoot 'engine-sha-after-pack.json') ([ordered]@{expected=$engineSha;isolated_repo_engine=$engineSha;path=$repoEngine})
Write-Output 'PACK RETRY PASS：唯一 retry exit0，配置副本已按 SHA 精确删除；下一阶段只执行验证。'
