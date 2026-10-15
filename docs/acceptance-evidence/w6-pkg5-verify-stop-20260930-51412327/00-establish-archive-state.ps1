param()

. (Join-Path $PSScriptRoot 'W6.Resume.Common.ps1')

$worktree = 'D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737'
$zip = Join-Path $worktree 'VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-0.5.15-agent-trial-pkg5.zip'
$manifestPath = Join-Path $worktree 'VideoAutoCutDesktop\runtime-release\manifest.json'
$configCopy = Join-Path $worktree 'VideoAutoCutDesktop\release-upload.local.json'
$oldAudit = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\node_modules\.tmp\w6-51411450-one-retry-20260930'

if (Test-Path -LiteralPath $script:SourceLockPath) { throw 'fresh SOURCE-LOCK 已存在' }
$lockData = [ordered]@{
  schema=3; authorized_instruction=51412327; source_head=$script:SourceHead; source_head_full=$true
  branch=$script:Branch; master=$script:Master; runtime_version=$script:RuntimeVersion; runtime_base=$script:BaseRuntime
  worktree=$worktree; worktree_zip=$zip; worktree_manifest=$manifestPath; main_manifest=$script:MainManifest
  main_manifest_sha256_must_remain=$script:ProtectedSpecs.main_manifest.sha256
  committed_package_only=$true; copy_user_dirty_package_files=$false; continuation_from_comment=51412010
  existing_archive_only=$true; repack_allowed=$false; verify30_limit=1; hash40_limit=1
}
Write-Json $script:SourceLockPath $lockData
$lock = Read-SourceLock

Assert-MainLocked $lock 'establish-entry'
Assert-IsolatedWorktree $lock 'establish-entry'
if ((Get-WorktreeGitScalar $lock @('rev-parse','--abbrev-ref','HEAD')) -ne 'HEAD') { throw '隔离 worktree 不是 detached HEAD' }
if (Test-Path -LiteralPath $configCopy) { throw '隔离配置副本仍存在' }
if ((Get-Sha256 $zip) -ne '662882deedd897b04043b2cb78ff1a40c17fcfd09cfd80885ace3e1dfd5002f5' -or (Get-Item -LiteralPath $zip).Length -ne 669984472) { throw '现有 pkg5 身份不符' }
if ((Get-Sha256 $manifestPath) -ne 'c80642c7370fe4a310a30ab1ea3b8852093b7986dd8cd67f8588ace69c1bda0c' -or (Get-Item -LiteralPath $manifestPath).Length -ne 433) { throw '现有隔离 manifest 身份不符' }
$artifact = Assert-IsolatedManifestMatchesArtifact $lock
$repoEngine = Join-Path $worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe'
$engineSha = Get-Sha256 $repoEngine
if ($engineSha -ne 'eadea1955d1aed3543de74fd647ede7f2e1638ae903b9bd056213e2e75ea9085') { throw '冻结新 engine SHA 不符' }

$oldConsume = Join-Path $oldAudit 'consume-once.json'
$oldPackLog = Join-Path $oldAudit 'pack-runtime-retry.log'
if (-not (Test-Path -LiteralPath $oldConsume -PathType Leaf) -or -not (Test-Path -LiteralPath $oldPackLog -PathType Leaf)) { throw '缺少上轮唯一 pack 事实收据' }
$consume = Get-Content -LiteralPath $oldConsume -Raw -Encoding utf8 | ConvertFrom-Json
if ($consume.retry_ordinal -ne 1 -or $consume.retry_limit -ne 1 -or $consume.must_never_invoke_again -ne $true) { throw '上轮 consume-once 不符' }
if ((Get-FileHash -LiteralPath $oldPackLog -Algorithm SHA256).Hash.ToLowerInvariant() -ne '0599d01d4681ffacbe42fad466731cf9d5e486e8a219ba0da0dc541cf58f8c91') { throw '上轮 pack log SHA 不符' }

$processTemp = Join-Path $script:AuditRoot 'process-temp'
$piAgentDir = Join-Path $script:AuditRoot 'pi-coding-agent-empty'
foreach ($path in @($processTemp,$piAgentDir)) {
  if (Test-Path -LiteralPath $path) { throw "fresh 隔离目录已存在：$path" }
  [System.IO.Directory]::CreateDirectory($path) | Out-Null
  if (@(Get-ChildItem -LiteralPath $path -Force).Count -ne 0) { throw "fresh 隔离目录非空：$path" }
}

$head = Get-WorktreeGitScalar $lock @('rev-parse','HEAD')
$protectedBefore = @(Get-ProtectedSnapshot)
Write-Json (Join-Path $script:AuditRoot 'protected-main-before.json') $protectedBefore
Write-Json (Join-Path $script:AuditRoot 'config-copy-cleanup.json') ([ordered]@{
  authorized_by=51411758; fixed_target='isolated-worktree/VideoAutoCutDesktop/release-upload.local.json'
  target_absent=$true; main_config_sha256=(Get-Sha256 $script:ProtectedSpecs.release_upload_config.path)
  main_config_unchanged=$true; content_recorded=$false
})
Write-Json (Join-Path $script:AuditRoot 'archive-continuation.json') ([ordered]@{
  instruction=51412327; source_head=$head; isolated_detached_head=$true
  archive=[ordered]@{ path=$zip; bytes=[int64](Get-Item -LiteralPath $zip).Length; sha256=$artifact.sha256 }
  manifest=[ordered]@{ path=$manifestPath; bytes=[int64](Get-Item -LiteralPath $manifestPath).Length; sha256=$artifact.manifest_sha256 }
  engine_sha256=$engineSha; engine_freeze_accepted_by=51412327; engine_freeze_evidence_commit='e82be4c8c38e21847d215f7508c0025862b700c3'
  engine_normalized_sha256='4425d7574e226fdf96a6023ae2f0bd28d71585307c4a2fb5357c5900f884413b'
  prior_pack_retry_calls=1; prior_npm_pack_exit=0; prior_wrapper_state_complete=$false
  existing_archive_reused=$true; repack_run=$false; verify30_calls=0; hash40_calls=0
})
$state = [ordered]@{
  source_head=$script:SourceHead; main_evidence_head=$script:MainEvidenceHead; worktree=$worktree
  head_create=$head; head_before_pack=$head; pack_zip_sha256=$artifact.sha256; pack_retry_calls=1
  archive_complete=$true; pack_wrapper_complete=$false; config_copy_deleted=$true
  credential_scan_complete=$false; worktree_complete=$true; verify30_calls=0; hash40_calls=0
  verify_complete=$false; hashes_complete=$false; cleanup_started=$false
}
Save-State $state
Write-Output 'ARCHIVE STATE PASS：复用现有 archive；未重包。等待 Root 审核后仅执行 30/40。'
